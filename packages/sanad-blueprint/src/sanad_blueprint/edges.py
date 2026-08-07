"""The relationship matrix (PRD §11.1) — which edges are derived from which
manifest fields, and which source→target kind pairs are legal.

Edges are DERIVED from resource manifests wherever a native field exists; the
graph never stores an opaque edge database (PRD principle 6.1, §10.5). Each
entry maps a spec field on a source kind to an edge type and the kinds it may
point at.
"""

from __future__ import annotations

from dataclasses import dataclass

from .schemas import ResourceKind


@dataclass(frozen=True)
class EdgeRule:
    edge_type: str
    # The spec field on the source resource that lists target ids.
    source_field: str
    source_kind: ResourceKind
    # Target kinds this edge may legally point to.
    target_kinds: tuple[ResourceKind, ...]


# Derivation rules: (source kind, spec field) -> edge. Order is display order.
EDGE_RULES: tuple[EdgeRule, ...] = (
    EdgeRule("uses", "skills", ResourceKind.AGENT, (ResourceKind.SKILL,)),
    EdgeRule("uses", "context", ResourceKind.AGENT, (ResourceKind.CONTEXT_DOCUMENT,)),
    EdgeRule("invokes", "tools", ResourceKind.AGENT, (ResourceKind.TOOL,)),
    EdgeRule("connects_to", "mcps", ResourceKind.AGENT, (ResourceKind.MCP_SERVER,)),
    EdgeRule("governed_by", "policies", ResourceKind.AGENT, (ResourceKind.POLICY,)),
    EdgeRule("delegates_to", "delegatesTo", ResourceKind.AGENT, (ResourceKind.AGENT,)),
    EdgeRule("evaluated_by", "evaluations", ResourceKind.AGENT, (ResourceKind.EVALUATION,)),
    EdgeRule("invokes", "tools", ResourceKind.SKILL, (ResourceKind.TOOL,)),
    EdgeRule("connects_to", "mcps", ResourceKind.SKILL, (ResourceKind.MCP_SERVER,)),
    EdgeRule("governed_by", "policies", ResourceKind.SKILL, (ResourceKind.POLICY,)),
    EdgeRule(
        "triggers",
        "targets",
        ResourceKind.HOOK,
        (
            ResourceKind.AGENT,
            ResourceKind.TOOL,
            ResourceKind.WORKFLOW,
        ),
    ),
    EdgeRule("governed_by", "policies", ResourceKind.HOOK, (ResourceKind.POLICY,)),
    EdgeRule(
        "publishes_with", "publishProfiles", ResourceKind.PROJECT, (ResourceKind.PUBLISH_PROFILE,)
    ),
    EdgeRule("governed_by", "defaultPolicies", ResourceKind.PROJECT, (ResourceKind.POLICY,)),
    EdgeRule(
        "evaluated_by",
        "targets",
        ResourceKind.EVALUATION,
        (
            ResourceKind.AGENT,
            ResourceKind.SKILL,
            ResourceKind.WORKFLOW,
        ),
    ),
)

# Edges that expand capability/permission — flagged for elevated review in a
# change plan (PRD §11.2, §19.4). Not a security boundary here, just a hint.
PERMISSION_EXPANDING_EDGES: frozenset[str] = frozenset({"connects_to", "invokes", "triggers"})


def target_field_ids(spec: object, field: str) -> list[str]:
    """Read a list-of-ids field off a spec model (missing → empty)."""
    value = getattr(spec, field, None)
    if isinstance(value, list):
        return [v for v in value if isinstance(v, str)]
    return []
