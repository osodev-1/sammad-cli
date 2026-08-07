"use client";

import "@xyflow/react/dist/base.css";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  type Edge,
  type Node,
  type NodeTypes,
} from "@xyflow/react";
import { fetchBlueprintGraph } from "@/lib/blueprint/api";
import {
  worstSeverity,
  type BlueprintGraph,
  type BlueprintNode,
} from "@/lib/blueprint/types";
import { BlueprintNode as BlueprintNodeView } from "./nodes";
import { layoutGraph, type LayoutKind } from "./layout";
import Inspector from "./Inspector";

const POLL_MS = 4000;
const nodeTypes: NodeTypes = { blueprint: BlueprintNodeView };

/**
 * The read-only Blueprint Graph (M1). Polls the compiled graph, lays it out
 * with dagre, renders it with React Flow styled by the design system, and
 * cross-focuses with the file tree: selecting a node reveals its manifest,
 * and `focusResourceId` (from clicking a .sanad file) highlights its node.
 */
export default function GraphPanel({
  sessionId,
  visible,
  onOpenFile,
  focusResourceId,
}: {
  sessionId?: string;
  visible: boolean;
  onOpenFile: (path: string) => void;
  /** A resource id OR a .sanad manifest path to highlight (GR-005). */
  focusResourceId?: string | null;
}) {
  const [graph, setGraph] = useState<BlueprintGraph | null>(null);
  const [loading, setLoading] = useState(true);
  const [layout, setLayout] = useState<LayoutKind>("hierarchy");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  /* Poll while visible. The graph is cheap and the payload small; a version
     check (?ifVersionNot) is a fast-follow once the watcher lands in M2. */
  const load = useCallback(async () => {
    const g = await fetchBlueprintGraph(sessionId);
    setGraph(g);
    setLoading(false);
  }, [sessionId]);

  useEffect(() => {
    if (!visible) return;
    void load();
    const t = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, POLL_MS);
    return () => window.clearInterval(t);
  }, [visible, load]);

  /* focusResourceId may be a resource id or a manifest path; resolve to an id. */
  const focused = useMemo(() => {
    if (!focusResourceId || !graph) return null;
    if (graph.nodes.some((n) => n.id === focusResourceId))
      return focusResourceId;
    const byPath = graph.nodes.find((n) => n.path === focusResourceId);
    return byPath?.id ?? null;
  }, [focusResourceId, graph]);

  const rfNodes: Node[] = useMemo(() => {
    if (!graph) return [];
    const base: Node[] = graph.nodes.map((n) => ({
      id: n.id,
      type: "blueprint",
      position: { x: 0, y: 0 },
      data: {
        kind: n.kind,
        name: n.name,
        status: n.status,
        severity: worstSeverity(graph.diagnostics, n.id),
        focused: n.id === focused,
      },
    }));
    const edges: Edge[] = graph.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
    }));
    return layoutGraph(base, edges, layout);
  }, [graph, layout, focused]);

  const rfEdges: Edge[] = useMemo(() => {
    if (!graph) return [];
    return graph.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      label: e.type,
      animated: false,
      style: {
        stroke: e.broken ? "var(--ink)" : "var(--rule-strong)",
        strokeDasharray: e.broken ? "4 3" : undefined,
        strokeWidth: 1.5,
      },
      labelStyle: {
        fontFamily: "var(--font-mono)",
        fontSize: 9,
        fill: "var(--ink-muted)",
      },
      labelBgStyle: { fill: "var(--paper)" },
    }));
  }, [graph]);

  const selectedNode: BlueprintNode | null = useMemo(
    () => graph?.nodes.find((n) => n.id === selectedId) ?? null,
    [graph, selectedId],
  );

  /* When a .sanad file selection arrives from the tree, select its node. */
  useEffect(() => {
    if (focused) setSelectedId(focused);
  }, [focused]);

  const onNodeClick = useCallback((_: unknown, node: Node) => {
    setSelectedId(node.id);
  }, []);
  const onNodeDoubleClick = useCallback(
    (_: unknown, node: Node) => {
      const n = graph?.nodes.find((x) => x.id === node.id);
      if (n) onOpenFile(n.path);
    },
    [graph, onOpenFile],
  );

  if (!visible) return null;

  return (
    <div style={s.wrap}>
      <div style={s.main}>
        <div style={s.toolbar}>
          <span style={s.title}>Blueprint</span>
          <div style={s.views}>
            {(["hierarchy", "layered"] as const).map((k) => (
              <button
                key={k}
                style={{
                  ...s.viewBtn,
                  ...(layout === k ? s.viewBtnActive : null),
                }}
                onClick={() => setLayout(k)}
              >
                {k}
              </button>
            ))}
          </div>
        </div>

        {loading ? (
          <div style={s.empty}>Reading your blueprint…</div>
        ) : !graph?.initialized ? (
          <div style={s.empty}>
            No <code style={s.code}>.sanad</code> blueprint yet. Ask the agent
            to initialize one, or create{" "}
            <code style={s.code}>.sanad/sanad.yaml</code>.
          </div>
        ) : graph.nodes.length === 0 ? (
          <div style={s.empty}>The blueprint is empty.</div>
        ) : (
          <ReactFlow
            nodes={rfNodes}
            edges={rfEdges}
            nodeTypes={nodeTypes}
            onNodeClick={onNodeClick}
            onNodeDoubleClick={onNodeDoubleClick}
            fitView
            minZoom={0.2}
            maxZoom={2}
            proOptions={{ hideAttribution: true }}
            onlyRenderVisibleElements
          >
            <Background gap={18} color="var(--rule)" />
            <MiniMap
              pannable
              zoomable
              style={s.minimap}
              maskColor="rgba(0,0,0,0.06)"
            />
            <Controls showInteractive={false} />
          </ReactFlow>
        )}
      </div>

      {selectedNode && graph && (
        <Inspector
          node={selectedNode}
          graph={graph}
          onOpenFile={onOpenFile}
          onClose={() => setSelectedId(null)}
        />
      )}
    </div>
  );
}

const s: Record<string, CSSProperties> = {
  wrap: { flex: 1, minHeight: 0, display: "flex" },
  main: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
  },
  toolbar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "0.4rem 0.85rem",
    borderBottom: "1px solid var(--rule)",
    background: "var(--paper)",
  },
  title: {
    fontFamily: "var(--font-mono)",
    fontSize: "0.68rem",
    fontWeight: 600,
    letterSpacing: "0.12em",
    textTransform: "uppercase",
    color: "var(--ink-muted)",
  },
  views: { display: "inline-flex", gap: "2px" },
  viewBtn: {
    font: "inherit",
    fontSize: "0.72rem",
    color: "var(--ink-muted)",
    background: "none",
    border: "1px solid var(--rule-strong)",
    borderRadius: "var(--radius-pill)",
    padding: "0.1rem 0.6rem",
    cursor: "pointer",
  },
  viewBtnActive: {
    background: "var(--paper-sunken)",
    color: "var(--ink)",
    borderColor: "var(--ink)",
  },
  empty: {
    flex: 1,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    textAlign: "center",
    padding: "2rem",
    color: "var(--ink-muted)",
    fontSize: "0.9rem",
    lineHeight: 1.6,
  },
  code: {
    fontFamily: "var(--font-mono)",
    fontSize: "0.82em",
    background: "var(--paper-sunken)",
    padding: "0.05rem 0.3rem",
    borderRadius: "var(--radius-sm)",
  },
  minimap: { background: "var(--paper)", border: "1px solid var(--rule)" },
};
