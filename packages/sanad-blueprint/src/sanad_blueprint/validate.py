"""Validation entrypoint — index + compile + collect all diagnostics.

Covers the PRD §15 domains reachable without a runtime: file syntax & schema
(1), unique identity (2), reference resolution (4), relationship compatibility
(5), delegation cycle safety (6, delegation subset), linked-file existence (13,
partial), and entrypoint reachability (14). Runtime/trust/publish domains land
with their own phases.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from .diagnostics import Diagnostic, Severity
from .graph import compile_graph
from .indexer import BlueprintIndex, index_blueprint
from .schemas import ResourceKind


@dataclass
class ValidationReport:
    diagnostics: list[Diagnostic]

    @property
    def blocking(self) -> list[Diagnostic]:
        return [d for d in self.diagnostics if d.severity == Severity.BLOCKING]

    @property
    def warnings(self) -> list[Diagnostic]:
        return [d for d in self.diagnostics if d.severity == Severity.WARNING]

    @property
    def ok(self) -> bool:
        return not self.blocking


def validate_index(index: BlueprintIndex) -> ValidationReport:
    graph = compile_graph(index)
    diagnostics = list(graph.diagnostics)
    diagnostics.extend(_entrypoint_reachability(index))
    diagnostics.extend(_supporting_file_existence(index))
    return ValidationReport(diagnostics=diagnostics)


def validate_blueprint(sanad_dir: str | Path) -> ValidationReport:
    return validate_index(index_blueprint(sanad_dir))


def _entrypoint_reachability(index: BlueprintIndex) -> list[Diagnostic]:
    """Project entrypoint agents must resolve to Agent resources (§15.14)."""
    out: list[Diagnostic] = []
    for indexed in index.by_kind(ResourceKind.PROJECT):
        entrypoints = getattr(indexed.resource.spec, "entrypoints", {}) or {}
        for agent_id in entrypoints.get("agents", []) if isinstance(entrypoints, dict) else []:
            target = index.resources.get(agent_id)
            if target is None:
                out.append(
                    Diagnostic.blocking(
                        "unreachable_entrypoint",
                        f"Project entrypoint {agent_id!r} does not exist",
                        resource_id=indexed.resource.metadata.id,
                        path=indexed.manifest_path,
                    )
                )
            elif target.resource.kind != ResourceKind.AGENT:
                out.append(
                    Diagnostic.blocking(
                        "unreachable_entrypoint",
                        f"Project entrypoint {agent_id!r} is not an Agent",
                        resource_id=indexed.resource.metadata.id,
                        path=indexed.manifest_path,
                    )
                )
    return out


# Spec fields that reference a supporting file relative to the manifest folder.
_FILE_REF_FIELDS = ("prompt", "instructions", "document", "body")


def _supporting_file_existence(index: BlueprintIndex) -> list[Diagnostic]:
    """A referenced local file (prompt.md, SKILL.md, …) must exist (§15.13)."""
    out: list[Diagnostic] = []
    known = set(index.file_hashes)
    for rid, indexed in index.resources.items():
        base = Path(indexed.manifest_path).parent
        for field_name in _FILE_REF_FIELDS:
            ref = getattr(indexed.resource.spec, field_name, None)
            if not isinstance(ref, str) or not ref:
                continue
            if ref.startswith(("http://", "https://", "/")) or ":" in ref:
                continue  # url or non-file reference
            candidate = str((base / ref).as_posix())
            if candidate not in known:
                out.append(
                    Diagnostic.warning(
                        "missing_supporting_file",
                        f"{rid}: referenced file {ref!r} not found ({candidate})",
                        resource_id=rid,
                        path=indexed.manifest_path,
                    )
                )
    return out
