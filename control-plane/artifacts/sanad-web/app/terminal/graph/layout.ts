import Dagre from "@dagrejs/dagre";
import type { Edge, Node } from "@xyflow/react";

export type LayoutKind = "hierarchy" | "layered";

const NODE_W = 190;
const NODE_H = 46;

/**
 * Deterministic layout via dagre — no animation loop, no simulation. Runs in a
 * useMemo. "hierarchy" is top-down (project → agents → skills → tools);
 * "layered" is left-right, which reads better for wide execution graphs.
 */
export function layoutGraph(
  nodes: Node[],
  edges: Edge[],
  kind: LayoutKind,
): Node[] {
  const g = new Dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
  g.setGraph({
    rankdir: kind === "layered" ? "LR" : "TB",
    nodesep: 40,
    ranksep: 70,
    marginx: 20,
    marginy: 20,
  });

  for (const n of nodes) g.setNode(n.id, { width: NODE_W, height: NODE_H });
  // Only real (resolvable) edges shape the layout; broken edges have no target
  // node and would throw. They still render, just don't influence ranks.
  const nodeIds = new Set(nodes.map((n) => n.id));
  for (const e of edges) {
    if (nodeIds.has(e.source) && nodeIds.has(e.target))
      g.setEdge(e.source, e.target);
  }

  Dagre.layout(g);

  return nodes.map((n) => {
    const pos = g.node(n.id);
    // dagre gives center coords; React Flow positions the top-left corner.
    return {
      ...n,
      position: {
        x: (pos?.x ?? 0) - NODE_W / 2,
        y: (pos?.y ?? 0) - NODE_H / 2,
      },
    };
  });
}
