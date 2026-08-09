"""Blueprint change plans — build, apply atomically, and roll back.

Pure logic (file I/O is synchronous and self-contained; agentd wraps apply in
a per-workspace lock and persists the record). A plan is a set of file
operations plus sha256 preconditions: apply verifies every precondition before
writing, so a manifest changed by the PTY agent since the plan was drafted
makes apply fail cleanly (AI-008 / Scenario G) rather than clobber.
"""

from __future__ import annotations

import hashlib
import os
from collections.abc import Sequence
from dataclasses import asdict, dataclass, field
from pathlib import Path, PurePosixPath

import yaml

from .edges import EDGE_RULES
from .envelope import parse_manifest
from .indexer import _MANIFEST_NAMES, BlueprintIndex
from .schemas import ResourceKind
from .templates import KIND_DIR, render, slugify


def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


class PlanError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def _check_plan_path(path: str) -> None:
    """Every plan path must stay inside `.sanad/` — no traversal, no absolutes.

    Plans arrive from clients (the browser posts them back for apply), so this
    is a security boundary, not a convenience: without it a crafted operation
    like `../blueprint-trust.json` could write outside the blueprint — into
    the trust store, the user's HOME, anywhere the agent uid can reach.
    """
    pure = PurePosixPath(path)
    if pure.is_absolute() or path.startswith("\\") or ".." in pure.parts:
        raise PlanError("invalid_path", f"illegal path: {path!r}")
    if not path.startswith(".sanad/") or path == ".sanad/":
        raise PlanError("invalid_path", f"plans may only touch .sanad/: {path!r}")


@dataclass
class Precondition:
    path: str  # repo-relative (".sanad/...")
    sha256: str | None  # None ⇒ the file must NOT exist (create safety)


@dataclass
class Operation:
    op: str  # "create" | "update" | "delete"
    path: str
    content: str | None = None  # for create/update


@dataclass
class ChangePlan:
    summary: str
    operations: list[Operation] = field(default_factory=list)
    preconditions: list[Precondition] = field(default_factory=list)
    nodes_added: list[str] = field(default_factory=list)
    nodes_changed: list[str] = field(default_factory=list)
    edges_added: list[dict[str, str]] = field(default_factory=list)

    def to_dict(self) -> dict[str, object]:
        return {
            "summary": self.summary,
            "operations": [asdict(o) for o in self.operations],
            "preconditions": [asdict(p) for p in self.preconditions],
            "graphDelta": {
                "nodesAdded": self.nodes_added,
                "nodesChanged": self.nodes_changed,
                "edgesAdded": self.edges_added,
            },
        }


def plan_from_dict(raw: dict) -> ChangePlan:
    """Reconstruct a plan the client is sending back for apply."""
    ops = [
        Operation(op=o["op"], path=o["path"], content=o.get("content"))
        for o in raw.get("operations", [])
    ]
    pres = [
        Precondition(path=p["path"], sha256=p.get("sha256")) for p in raw.get("preconditions", [])
    ]
    delta = raw.get("graphDelta", {})
    return ChangePlan(
        summary=raw.get("summary", ""),
        operations=ops,
        preconditions=pres,
        nodes_added=list(delta.get("nodesAdded", [])),
        nodes_changed=list(delta.get("nodesChanged", [])),
        edges_added=list(delta.get("edgesAdded", [])),
    )


# ----------------------------------------------------------- plan builders ---


def plan_create_resource(index: BlueprintIndex, kind: ResourceKind, name: str) -> ChangePlan:
    if kind not in KIND_DIR:
        raise PlanError("unsupported_kind", f"cannot scaffold {kind.value}")
    from .schemas import KIND_ID_PREFIX

    slug = slugify(name)
    rid = f"{KIND_ID_PREFIX[kind]}:{slug}"
    if rid in index.resources:
        raise PlanError("duplicate_id", f"{rid} already exists")

    folder = f".sanad/{KIND_DIR[kind]}/{slug}"
    ops: list[Operation] = []
    pres: list[Precondition] = []
    for tf in render(kind, rid, name):
        path = f"{folder}/{tf.rel}"
        ops.append(Operation(op="create", path=path, content=tf.content))
        pres.append(Precondition(path=path, sha256=None))  # must not exist
    return ChangePlan(
        summary=f"Create {kind.value} “{name}”",
        operations=ops,
        preconditions=pres,
        nodes_added=[rid],
    )


def plan_create_edge(
    index: BlueprintIndex, source_id: str, target_id: str, edge_type: str | None = None
) -> ChangePlan:
    """Add a typed edge. If `edge_type` is omitted (drag-to-connect), infer the
    first legal relationship between the two kinds."""
    source = index.resources.get(source_id)
    if source is None:
        raise PlanError("unknown_source", f"no resource {source_id}")
    target = index.resources.get(target_id)
    if target is None:
        raise PlanError("unknown_target", f"no resource {target_id}")

    # The rule must match the source kind, accept the target's kind, and (when
    # given) the requested edge type — otherwise it is not a legal edge (§11.2).
    field_name: str | None = None
    for rule in EDGE_RULES:
        if (
            rule.source_kind == source.resource.kind
            and target.resource.kind in rule.target_kinds
            and (edge_type is None or rule.edge_type == edge_type)
        ):
            field_name = rule.source_field
            edge_type = rule.edge_type
            break
    if field_name is None or edge_type is None:
        want = f"{edge_type} " if edge_type else ""
        raise PlanError(
            "invalid_relationship",
            f"{source.resource.kind.value} cannot {want}connect to a {target.resource.kind.value}",
        )

    manifest_path = source.manifest_path
    current_hash = index.file_hashes.get(manifest_path)
    if current_hash is None:
        raise PlanError("missing_manifest", f"manifest {manifest_path} not indexed")

    # Load the on-disk manifest, append the target id to the field's list, and
    # re-dump. Reading the file (not the parsed model) keeps content faithful.
    doc = _load_manifest_doc(index, manifest_path)
    spec = doc.setdefault("spec", {})
    existing = spec.get(field_name)
    if not isinstance(existing, list):
        existing = []
    if target_id in existing:
        raise PlanError("edge_exists", f"{source_id} already {edge_type} {target_id}")
    spec[field_name] = [*existing, target_id]
    new_content = yaml.safe_dump(doc, sort_keys=False, default_flow_style=False)

    return ChangePlan(
        summary=f"{source_id} {edge_type} {target_id}",
        operations=[Operation(op="update", path=manifest_path, content=new_content)],
        preconditions=[Precondition(path=manifest_path, sha256=current_hash)],
        edges_added=[{"from": source_id, "type": edge_type, "to": target_id}],
    )


MAX_PLAN_FILES = 20
MAX_FILE_CHARS = 200_000


def plan_write_files(
    index: BlueprintIndex, files: Sequence[tuple[str, str]], summary: str
) -> ChangePlan:
    """Plan writing author-supplied file contents (the Architect's editor).

    Unlike ``plan_create_resource`` (template scaffold), the caller supplies
    the COMPLETE desired content of each file — new or existing — so an agent
    can draft real definitions and keep iterating on them. Manifests must
    parse through the envelope before they can enter a plan (a proposal can
    never make the blueprint less valid than the author intended); every
    precondition is hashed from disk, so a file that changed since drafting
    fails apply cleanly instead of being clobbered (Scenario G).
    """
    if not files:
        raise PlanError("empty_plan", "no files to write")
    if len(files) > MAX_PLAN_FILES:
        raise PlanError("too_many_files", f"a plan may touch at most {MAX_PLAN_FILES} files")

    workspace = Path(index.root).parent
    seen_paths: set[str] = set()
    planned_ids: set[str] = set()
    ops: list[Operation] = []
    pres: list[Precondition] = []
    nodes_added: list[str] = []
    nodes_changed: list[str] = []

    for path, content in files:
        _check_plan_path(path)
        if path in seen_paths:
            raise PlanError("duplicate_path", f"{path} appears twice in the plan")
        seen_paths.add(path)
        if len(content) > MAX_FILE_CHARS:
            raise PlanError("file_too_large", f"{path} exceeds {MAX_FILE_CHARS} characters")

        target = workspace / path
        exists = target.is_file()

        if PurePosixPath(path).name in _MANIFEST_NAMES:
            parsed = parse_manifest(path, content)
            if parsed.resource is None:
                first = parsed.diagnostics[0].message if parsed.diagnostics else "invalid manifest"
                raise PlanError("manifest_invalid", f"{path}: {first}")
            rid = parsed.resource.metadata.id
            indexed = index.resources.get(rid)
            current = next((r for r in index.resources.values() if r.manifest_path == path), None)
            if exists:
                # Ids anchor every edge and trust record: an update keeps its id.
                if current is not None and current.resource.metadata.id != rid:
                    raise PlanError(
                        "id_changed",
                        f"{path} must keep id {current.resource.metadata.id!r} (got {rid!r}); "
                        "rename by creating a new resource and removing the old one",
                    )
                if current is None and indexed is not None and indexed.manifest_path != path:
                    raise PlanError("duplicate_id", f"{rid} already exists elsewhere")
                nodes_changed.append(rid)
            else:
                if indexed is not None or rid in planned_ids:
                    raise PlanError("duplicate_id", f"{rid} already exists")
                nodes_added.append(rid)
            planned_ids.add(rid)

        if exists:
            try:
                current_text = target.read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError) as exc:
                raise PlanError("file_unreadable", f"{path}: {exc}") from exc
            pres.append(Precondition(path=path, sha256=_sha256(current_text)))
            ops.append(Operation(op="update", path=path, content=content))
        else:
            pres.append(Precondition(path=path, sha256=None))
            ops.append(Operation(op="create", path=path, content=content))

    return ChangePlan(
        summary=summary.strip() or "Write blueprint files",
        operations=ops,
        preconditions=pres,
        nodes_added=nodes_added,
        nodes_changed=nodes_changed,
    )


def _load_manifest_doc(index: BlueprintIndex, rel_path: str) -> dict:
    abs_path = Path(index.root).parent / rel_path
    try:
        loaded = yaml.safe_load(abs_path.read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError) as exc:
        raise PlanError("manifest_unreadable", str(exc)) from exc
    if not isinstance(loaded, dict):
        raise PlanError("manifest_invalid", "manifest is not a mapping")
    return loaded


# ------------------------------------------------------------------ apply ---


@dataclass
class RollbackEntry:
    path: str
    action: str  # "delete" (was created) | "restore" (had prior content)
    prior_content: str | None = None


@dataclass
class ApplyResult:
    rollback: list[RollbackEntry]


def apply_plan(workspace_root: Path, plan: ChangePlan) -> ApplyResult:
    """Verify preconditions, then write every op atomically; on any failure,
    replay the rollback and re-raise. Returns rollback data for the record."""
    sanad_parent = workspace_root  # paths are ".sanad/..." relative to here

    # 0. Containment. Plans round-trip through clients, so apply re-checks
    #    every path even though planners already did — without this, a crafted
    #    plan could write ../blueprint-trust.json or escape the workspace.
    for pre in plan.preconditions:
        _check_plan_path(pre.path)
    for op in plan.operations:
        _check_plan_path(op.path)

    # 1. Verify all preconditions before touching anything.
    for pre in plan.preconditions:
        target = sanad_parent / pre.path
        if pre.sha256 is None:
            if target.exists():
                raise PlanError("precondition_failed", f"{pre.path} already exists")
        else:
            if not target.exists():
                raise PlanError("precondition_failed", f"{pre.path} no longer exists")
            actual = _sha256(target.read_text(encoding="utf-8"))
            if actual != pre.sha256:
                raise PlanError("stale_plan", f"{pre.path} changed since the plan was drafted")

    # 2. Apply, remembering how to undo each op.
    done: list[RollbackEntry] = []
    try:
        for op in plan.operations:
            target = sanad_parent / op.path
            if op.op in ("create", "update"):
                prior = (
                    target.read_text(encoding="utf-8")
                    if op.op == "update" and target.exists()
                    else None
                )
                target.parent.mkdir(parents=True, exist_ok=True)
                _atomic_write(target, op.content or "")
                done.append(
                    RollbackEntry(
                        path=op.path,
                        action="restore" if prior is not None else "delete",
                        prior_content=prior,
                    )
                )
            elif op.op == "delete":
                prior = target.read_text(encoding="utf-8") if target.exists() else None
                if target.exists():
                    target.unlink()
                done.append(RollbackEntry(path=op.path, action="restore", prior_content=prior))
            else:
                raise PlanError("bad_operation", f"unknown op {op.op!r}")
    except Exception:
        _replay_rollback(sanad_parent, done)
        raise

    return ApplyResult(rollback=list(reversed(done)))


def rollback(workspace_root: Path, entries: list[RollbackEntry]) -> None:
    _replay_rollback(workspace_root, entries)


def _replay_rollback(sanad_parent: Path, entries: list[RollbackEntry]) -> None:
    # Undo in reverse of application order.
    for entry in reversed(entries):
        target = sanad_parent / entry.path
        if entry.action == "delete":
            if target.exists():
                target.unlink()
        elif entry.action == "restore":
            if entry.prior_content is None:
                if target.exists():
                    target.unlink()
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                _atomic_write(target, entry.prior_content)


def _atomic_write(path: Path, content: str) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(content, encoding="utf-8")
    os.replace(tmp, path)
