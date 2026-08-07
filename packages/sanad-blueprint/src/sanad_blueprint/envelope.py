"""Two-stage lenient manifest parsing.

Stage 1: load YAML. Stage 2: validate the envelope (apiVersion/kind/metadata).
Stage 3: validate the kind-specific spec. A failure at any stage yields a
ParsedManifest carrying diagnostics rather than raising — a malformed file must
stay visible in the graph as an invalid node (NF-008, BR-005), never vanish.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import yaml
from pydantic import ValidationError

from .diagnostics import Diagnostic
from .schemas import API_VERSION, SPEC_MODELS, Metadata, Resource, ResourceKind


@dataclass
class ParsedManifest:
    """The result of parsing one manifest file — always produced, never raised."""

    path: str  # repo-relative, e.g. ".sanad/agents/primary/agent.yaml"
    raw: dict | None = None  # the loaded YAML mapping, if it loaded at all
    resource: Resource | None = None  # populated only on full success
    diagnostics: list[Diagnostic] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return self.resource is not None

    @property
    def resource_id(self) -> str | None:
        if self.resource is not None:
            return self.resource.metadata.id
        # Best-effort id even for an invalid resource, so its node has an anchor.
        if isinstance(self.raw, dict):
            meta = self.raw.get("metadata")
            if isinstance(meta, dict) and isinstance(meta.get("id"), str):
                return meta["id"]
        return None


def _pydantic_messages(
    exc: ValidationError, path: str, resource_id: str | None
) -> list[Diagnostic]:
    out: list[Diagnostic] = []
    for err in exc.errors():
        loc = ".".join(str(p) for p in err.get("loc", ()))
        msg = err.get("msg", "invalid")
        out.append(
            Diagnostic.blocking(
                "schema_invalid",
                f"{loc}: {msg}" if loc else msg,
                resource_id=resource_id,
                path=path,
            )
        )
    return out


def parse_manifest(path: str, text: str) -> ParsedManifest:
    """Parse one YAML manifest into a ParsedManifest (never raises)."""
    parsed = ParsedManifest(path=path)

    # Stage 1 — YAML.
    try:
        loaded = yaml.safe_load(text)
    except yaml.YAMLError as exc:
        parsed.diagnostics.append(
            Diagnostic.blocking("yaml_syntax", f"YAML parse error: {exc}", path=path)
        )
        return parsed
    if loaded is None:
        parsed.diagnostics.append(Diagnostic.blocking("empty_file", "Manifest is empty", path=path))
        return parsed
    if not isinstance(loaded, dict):
        parsed.diagnostics.append(
            Diagnostic.blocking("not_mapping", "Manifest must be a YAML mapping", path=path)
        )
        return parsed
    parsed.raw = loaded

    # Stage 2 — envelope (kind + metadata) enough to place a node.
    kind_raw = loaded.get("kind")
    try:
        kind = ResourceKind(kind_raw)
    except ValueError:
        parsed.diagnostics.append(
            Diagnostic.blocking(
                "unknown_kind",
                f"Unknown or missing kind: {kind_raw!r}",
                resource_id=parsed.resource_id,
                path=path,
            )
        )
        return parsed

    try:
        metadata = Metadata.model_validate(loaded.get("metadata", {}))
    except ValidationError as exc:
        parsed.diagnostics.extend(_pydantic_messages(exc, path, parsed.resource_id))
        return parsed

    api_version = loaded.get("apiVersion")
    if api_version != API_VERSION:
        parsed.diagnostics.append(
            Diagnostic.warning(
                "api_version",
                f"Expected apiVersion {API_VERSION!r}, got {api_version!r}",
                resource_id=metadata.id,
                path=path,
            )
        )

    # Stage 3 — kind-specific spec.
    spec_model = SPEC_MODELS[kind]
    try:
        spec = spec_model.model_validate(loaded.get("spec", {}))
    except ValidationError as exc:
        parsed.diagnostics.extend(_pydantic_messages(exc, path, metadata.id))
        return parsed

    parsed.resource = Resource(
        apiVersion=api_version or API_VERSION,
        kind=kind,
        metadata=metadata,
        spec=spec,
    )
    return parsed
