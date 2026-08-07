"""The graph compiler — build nodes and typed edges from the index.

The graph is a derived projection: nodes for each resource (plus unclassified
files), edges derived from manifest fields via the relationship matrix. It is
never the canonical store (PRD principle 6.1). Unresolved edge targets become
visible broken-edge placeholders (GR-009), not silent drops.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from pathlib import Path

from .diagnostics import Diagnostic
from .edges import EDGE_RULES, PERMISSION_EXPANDING_EDGES, target_field_ids
from .indexer import BlueprintIndex
from .schemas import ResourceKind


@dataclass
class Node:
    id: str
    kind: str  # ResourceKind value, or "UnclassifiedFile"
    name: str
    path: str  # manifest path or file path
    status: str = "ok"  # ok | invalid | unclassified
    supporting_paths: list[str] = field(default_factory=list)


@dataclass
class Edge:
    # Stable synthetic id so the UI can key/animate edges.
    id: str
    source: str
    target: str
    type: str
    # True when the target id does not resolve to a node (broken reference).
    broken: bool = False
    # True for capability/permission-expanding edges (elevated review hint).
    permission_expanding: bool = False


@dataclass
class BlueprintGraph:
    nodes: list[Node]
    edges: list[Edge]
    diagnostics: list[Diagnostic]

    def to_dict(self) -> dict:
        return {
            "nodes": [asdict(n) for n in self.nodes],
            "edges": [asdict(e) for e in self.edges],
            "diagnostics": [d.model_dump() for d in self.diagnostics],
        }


def compile_graph(index: BlueprintIndex) -> BlueprintGraph:
    nodes: list[Node] = []
    edges: list[Edge] = []
    diagnostics: list[Diagnostic] = list(index.diagnostics)

    invalid_ids = {
        d.resource_id for d in index.diagnostics if d.resource_id and d.severity.value == "blocking"
    }

    for rid, indexed in index.resources.items():
        res = indexed.resource
        nodes.append(
            Node(
                id=rid,
                kind=res.kind.value,
                name=res.metadata.name,
                path=indexed.manifest_path,
                status="invalid" if rid in invalid_ids else "ok",
                supporting_paths=list(indexed.supporting_paths),
            )
        )

    for rel in index.unclassified:
        nodes.append(
            Node(
                id=f"file:{rel}",
                kind="UnclassifiedFile",
                name=Path(rel).name,
                path=rel,
                status="unclassified",
            )
        )

    node_ids = {n.id for n in nodes}

    # Derive edges from manifest fields.
    for rid, indexed in index.resources.items():
        res = indexed.resource
        for rule in EDGE_RULES:
            if res.kind != rule.source_kind:
                continue
            for target_id in target_field_ids(res.spec, rule.source_field):
                broken = target_id not in node_ids
                edges.append(
                    Edge(
                        id=f"{rid}--{rule.edge_type}--{target_id}",
                        source=rid,
                        target=target_id,
                        type=rule.edge_type,
                        broken=broken,
                        permission_expanding=rule.edge_type in PERMISSION_EXPANDING_EDGES,
                    )
                )
                if broken:
                    diagnostics.append(
                        Diagnostic.blocking(
                            "unresolved_reference",
                            f"{rid} {rule.edge_type} unknown resource {target_id!r}",
                            resource_id=rid,
                            path=indexed.manifest_path,
                        )
                    )
                elif _target_kind_illegal(target_id, index, rule.target_kinds):
                    diagnostics.append(
                        Diagnostic.blocking(
                            "invalid_relationship",
                            f"{rid} {rule.edge_type} → {target_id}: incompatible target kind",
                            resource_id=rid,
                            path=indexed.manifest_path,
                        )
                    )

    diagnostics.extend(_delegation_cycles(index))
    return BlueprintGraph(nodes=nodes, edges=edges, diagnostics=diagnostics)


def _target_kind_illegal(
    target_id: str, index: BlueprintIndex, allowed: tuple[ResourceKind, ...]
) -> bool:
    target = index.resources.get(target_id)
    if target is None:
        return False  # broken is reported separately
    return target.resource.kind not in allowed


def _delegation_cycles(index: BlueprintIndex) -> list[Diagnostic]:
    """Blocking diagnostic for any delegates_to cycle (PRD §11.2, VA-004)."""
    graph: dict[str, list[str]] = {}
    for rid, indexed in index.resources.items():
        if indexed.resource.kind == ResourceKind.AGENT:
            graph[rid] = target_field_ids(indexed.resource.spec, "delegatesTo")

    diags: list[Diagnostic] = []
    WHITE, GREY, BLACK = 0, 1, 2
    color: dict[str, int] = {n: WHITE for n in graph}

    def visit(node: str, stack: list[str]) -> None:
        color[node] = GREY
        for nxt in graph.get(node, ()):
            if nxt not in graph:
                continue
            if color[nxt] == GREY:
                cycle = " → ".join([*stack[stack.index(nxt) :], nxt]) if nxt in stack else f"{node} → {nxt}"
                diags.append(
                    Diagnostic.blocking(
                        "delegation_cycle",
                        f"delegates_to cycle: {cycle}",
                        resource_id=node,
                    )
                )
            elif color[nxt] == WHITE:
                visit(nxt, [*stack, nxt])
        color[node] = BLACK

    for node in graph:
        if color[node] == WHITE:
            visit(node, [node])
    return diags
