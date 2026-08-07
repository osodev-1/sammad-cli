import { describe, it, expect } from "vitest";
import type { Edge, Node } from "@xyflow/react";
import { layoutGraph } from "@/app/terminal/graph/layout";
import { worstSeverity, type Diagnostic } from "@/lib/blueprint/types";

const nodes: Node[] = [
  {
    id: "agent:primary",
    type: "blueprint",
    position: { x: 0, y: 0 },
    data: {},
  },
  { id: "skill:review", type: "blueprint", position: { x: 0, y: 0 }, data: {} },
];
const edges: Edge[] = [
  { id: "e1", source: "agent:primary", target: "skill:review" },
];

describe("graph layout", () => {
  it("assigns non-overlapping positions and is deterministic", () => {
    const a = layoutGraph(nodes, edges, "hierarchy");
    const b = layoutGraph(nodes, edges, "hierarchy");
    expect(a.map((n) => n.position)).toEqual(b.map((n) => n.position));
    // Distinct positions for the two nodes.
    expect(a[0].position).not.toEqual(a[1].position);
  });

  it("ignores broken edges (target missing) without throwing", () => {
    const broken: Edge[] = [
      { id: "e2", source: "agent:primary", target: "skill:ghost" },
    ];
    expect(() => layoutGraph(nodes, broken, "layered")).not.toThrow();
  });

  it("hierarchy stacks vertically; layered spreads horizontally", () => {
    const h = layoutGraph(nodes, edges, "hierarchy");
    const l = layoutGraph(nodes, edges, "layered");
    const hDy = Math.abs(h[0].position.y - h[1].position.y);
    const lDx = Math.abs(l[0].position.x - l[1].position.x);
    expect(hDy).toBeGreaterThan(0);
    expect(lDx).toBeGreaterThan(0);
  });
});

describe("worstSeverity", () => {
  const diags: Diagnostic[] = [
    {
      severity: "warning",
      code: "w",
      message: "",
      resource_id: "a",
      path: null,
    },
    {
      severity: "blocking",
      code: "b",
      message: "",
      resource_id: "a",
      path: null,
    },
    { severity: "info", code: "i", message: "", resource_id: "b", path: null },
  ];
  it("returns the highest severity per resource", () => {
    expect(worstSeverity(diags, "a")).toBe("blocking");
    expect(worstSeverity(diags, "b")).toBe("info");
    expect(worstSeverity(diags, "c")).toBeNull();
  });
});
