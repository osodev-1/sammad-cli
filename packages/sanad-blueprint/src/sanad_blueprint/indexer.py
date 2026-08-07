"""The blueprint indexer — walk ``.sanad``, parse manifests, resolve ids.

Produces a BlueprintIndex: the classified resources, the unclassified files,
and the per-file diagnostics. This is the in-memory projection the graph
compiler and validators consume; it is disposable and fully reconstructable
from the files (NF-005).
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from pathlib import Path

from .diagnostics import Diagnostic
from .envelope import ParsedManifest, parse_manifest
from .schemas import Resource, ResourceKind

# Files parsed as resource manifests. Supporting files (SKILL.md, scripts, …)
# are indexed as plain files owned by the nearest resource folder.
_MANIFEST_NAMES = {
    "sanad.yaml",
    "agent.yaml",
    "skill.yaml",
    "tool.yaml",
    "mcp.yaml",
    "hook.yaml",
    "workflow.yaml",
    "policy.yaml",
    "evaluation.yaml",
    "template.yaml",
}
# Any *.yaml directly under publish/ is a PublishProfile.
_PUBLISH_DIR = "publish"
# Never walked: the disposable cache.
_CACHE_DIR = ".cache"


@dataclass
class IndexedResource:
    resource: Resource
    manifest_path: str  # repo-relative
    # Supporting files nested under this resource's folder.
    supporting_paths: list[str] = field(default_factory=list)


@dataclass
class BlueprintIndex:
    root: str  # absolute path to the .sanad directory
    resources: dict[str, IndexedResource] = field(default_factory=dict)  # id -> resource
    # Files under .sanad that are not recognized manifests (rendered as
    # "Unclassified File" nodes, PRD §10.6).
    unclassified: list[str] = field(default_factory=list)
    diagnostics: list[Diagnostic] = field(default_factory=list)
    # Content hash of every manifest, for transaction preconditions.
    file_hashes: dict[str, str] = field(default_factory=dict)

    def by_kind(self, kind: ResourceKind) -> list[IndexedResource]:
        return [r for r in self.resources.values() if r.resource.kind == kind]


def _is_manifest(path: Path) -> bool:
    if path.name in _MANIFEST_NAMES:
        return True
    # publish/<env>.yaml → PublishProfile
    return path.parent.name == _PUBLISH_DIR and path.suffix in (".yaml", ".yml")


def index_blueprint(sanad_dir: str | Path) -> BlueprintIndex:
    """Walk a ``.sanad`` directory and build the index (never raises)."""
    root = Path(sanad_dir)
    index = BlueprintIndex(root=str(root))
    if not root.is_dir():
        return index

    manifests: list[ParsedManifest] = []
    all_files: list[Path] = []
    for path in sorted(root.rglob("*")):
        if _CACHE_DIR in path.relative_to(root).parts:
            continue
        if path.is_dir():
            continue
        all_files.append(path)

    manifest_paths: set[Path] = set()
    for path in all_files:
        rel = str(path.relative_to(root.parent))  # ".sanad/..."
        try:
            content = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            index.unclassified.append(rel)
            continue
        index.file_hashes[rel] = hashlib.sha256(content.encode("utf-8")).hexdigest()
        if _is_manifest(path):
            manifest_paths.add(path)
            manifests.append(parse_manifest(rel, content))

    # Classify manifests; collect their diagnostics.
    for parsed in manifests:
        index.diagnostics.extend(parsed.diagnostics)
        if parsed.ok and parsed.resource is not None:
            rid = parsed.resource.metadata.id
            if rid in index.resources:
                index.diagnostics.append(
                    Diagnostic.blocking(
                        "duplicate_id",
                        f"Duplicate resource id {rid!r} "
                        f"(also {index.resources[rid].manifest_path})",
                        resource_id=rid,
                        path=parsed.path,
                    )
                )
                continue
            index.resources[rid] = IndexedResource(
                resource=parsed.resource, manifest_path=parsed.path
            )

    # Attach supporting files to the nearest owning resource folder; the rest
    # are unclassified.
    resource_dirs = {
        str(Path(r.manifest_path).parent): rid for rid, r in index.resources.items()
    }
    for path in all_files:
        if path in manifest_paths:
            continue
        rel = str(path.relative_to(root.parent))
        owner = _nearest_owner(rel, resource_dirs)
        if owner is not None:
            index.resources[owner].supporting_paths.append(rel)
        else:
            index.unclassified.append(rel)

    return index


def _nearest_owner(rel_path: str, resource_dirs: dict[str, str]) -> str | None:
    """The id of the resource whose folder most-specifically contains rel_path."""
    parent = str(Path(rel_path).parent)
    best_dir: str | None = None
    for rdir in resource_dirs:
        if parent == rdir or parent.startswith(rdir + "/"):
            if best_dir is None or len(rdir) > len(best_dir):
                best_dir = rdir
    return resource_dirs[best_dir] if best_dir is not None else None
