"use client";

import "@xyflow/react/dist/base.css";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeTypes,
} from "@xyflow/react";
import {
  applyPlan,
  draftPlan,
  fetchBlueprintGraph,
  fetchCreatableKinds,
  reviewTrust,
  type ChangePlan,
  type CreatableKind,
} from "@/lib/blueprint/api";
import { subscribeBlueprintEvents } from "@/lib/blueprint/events";
import {
  worstSeverity,
  type BlueprintGraph,
  type BlueprintNode,
} from "@/lib/blueprint/types";
import { BlueprintNode as BlueprintNodeView } from "./nodes";
import { layoutGraph, type LayoutKind } from "./layout";
import Inspector from "./Inspector";
import PlanPreview from "./PlanPreview";

const POLL_MS = 4000;
const nodeTypes: NodeTypes = { blueprint: BlueprintNodeView };

/**
 * The Blueprint Graph. Reads the compiled graph (dagre layout, React Flow
 * styled by the design system) and — M2 — authors it: a New Node menu and
 * drag-to-connect both produce a change plan the user reviews before it is
 * written (MA-005/GR-007). Cross-focuses with the file tree (GR-004/005).
 */
export default function GraphPanel({
  sessionId,
  visible,
  onOpenFile,
  onApplied,
  onRestartAgents,
  focusResourceId,
  architectOpen,
  onToggleArchitect,
}: {
  sessionId?: string;
  visible: boolean;
  onOpenFile: (path: string) => void;
  /** Called after a plan is applied, with the paths it wrote (to reveal them). */
  onApplied?: (writtenPaths: string[]) => void;
  /** Kill + respawn the agent terminals so a new definition loads now (S9). */
  onRestartAgents?: () => void;
  /** A resource id OR a .sanad manifest path to highlight (GR-005). */
  focusResourceId?: string | null;
  /** The Architect chat lives beside the graph — this toggles it (M3c). */
  architectOpen?: boolean;
  onToggleArchitect?: () => void;
}) {
  const [graph, setGraph] = useState<BlueprintGraph | null>(null);
  const [loading, setLoading] = useState(true);
  const [layout, setLayout] = useState<LayoutKind>("hierarchy");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  /* Authoring state: a drafted plan awaiting the user's review, plus the
     New Node menu. */
  const [pendingPlan, setPendingPlan] = useState<ChangePlan | null>(null);
  const [applyBusy, setApplyBusy] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  /* S9: transient post-apply nudge + manual trust review in-flight flag.
     `noticeRestart` marks activation nudges — those get a restart action. */
  const [notice, setNotice] = useState<string | null>(null);
  const [noticeRestart, setNoticeRestart] = useState(false);
  const [trustBusy, setTrustBusy] = useState(false);
  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => {
      setNotice(null);
      setNoticeRestart(false);
    }, 12_000);
    return () => window.clearTimeout(t);
  }, [notice]);
  const [newMenu, setNewMenu] = useState(false);
  const [kinds, setKinds] = useState<CreatableKind[]>([]);
  const [newKind, setNewKind] = useState<string>("");
  const [newName, setNewName] = useState("");

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

  /* Prompt refresh on external edits (a PTY-agent write, a git checkout) via
     the machine's events channel — the 4s poll above is the reliable fallback
     if the socket drops (NF-001).

     The events socket mints a session, which would WAKE a stopped machine, so
     it is a strict follower of liveness, never a driver: run it only while the
     last poll succeeded (machine confirmed up — the poll itself never wakes)
     AND the browser tab is foregrounded. That also matches the invariant that
     external .sanad edits only happen while a session is live, so there is
     nothing to miss when the machine is asleep. */
  const machineUp = graph !== null;
  useEffect(() => {
    if (!visible || !machineUp) return;
    let dispose: (() => void) | null = null;
    const sync = () => {
      const shouldRun = document.visibilityState === "visible";
      if (shouldRun && !dispose) {
        dispose = subscribeBlueprintEvents(() => void load(), sessionId);
      } else if (!shouldRun && dispose) {
        dispose();
        dispose = null;
      }
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => {
      document.removeEventListener("visibilitychange", sync);
      if (dispose) dispose();
    };
  }, [visible, machineUp, sessionId, load]);

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
        trust: n.trust,
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
      if (!n) return;
      // For a skill, the substance is its instructions — open SKILL.md, not
      // the manifest (which stays one click away in the Inspector).
      const instructions =
        n.kind === "Skill"
          ? n.supporting_paths.find((p) => p.endsWith("/SKILL.md"))
          : undefined;
      onOpenFile(instructions ?? n.path);
    },
    [graph, onOpenFile],
  );

  /* Load the creatable kinds once, lazily — powers the New menu. */
  useEffect(() => {
    if (!visible || kinds.length) return;
    let live = true;
    void fetchCreatableKinds(sessionId)
      .then((k) => {
        if (!live) return;
        setKinds(k);
        if (k.length) setNewKind((cur) => cur || k[0].kind);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [visible, kinds.length, sessionId]);

  /* Draft (never write) a plan; the PlanPreview modal reviews it before apply.
     A planning error (illegal edge, duplicate) surfaces in the toolbar banner. */
  const draft = useCallback(
    async (req: Parameters<typeof draftPlan>[0]) => {
      setApplyError(null);
      const outcome = await draftPlan(req, sessionId);
      if (outcome.plan) {
        setPendingPlan(outcome.plan);
      } else {
        setPendingPlan(null);
        setApplyError(outcome.error?.message ?? "Could not plan that change.");
      }
    },
    [sessionId],
  );

  /* Drag-to-connect: React Flow hands us source+target; the kernel infers the
     one legal relationship between those two kinds (or rejects it). */
  const onConnect = useCallback(
    (conn: Connection) => {
      if (!conn.source || !conn.target || conn.source === conn.target) return;
      void draft({
        action: "createEdge",
        source: conn.source,
        target: conn.target,
      });
    },
    [draft],
  );

  const submitNewNode = useCallback(() => {
    if (!newKind || !newName.trim()) return;
    setNewMenu(false);
    void draft({
      action: "createResource",
      kind: newKind,
      name: newName.trim(),
    });
    setNewName("");
  }, [newKind, newName, draft]);

  const applyPending = useCallback(async () => {
    if (!pendingPlan) return;
    setApplyBusy(true);
    setApplyError(null);
    const paths = pendingPlan.operations.map((o) => o.path);
    const outcome = await applyPlan(pendingPlan, sessionId);
    setApplyBusy(false);
    if (outcome.graph) {
      setGraph(outcome.graph);
      setPendingPlan(null);
      onApplied?.(paths);
      // Activation is next-session (S9): say so, and offer the restart.
      if (paths.some((p) => p.endsWith("/SKILL.md"))) {
        setNotice("Applied — the skill is active in new terminals.");
        setNoticeRestart(true);
      }
    } else {
      setApplyError(
        outcome.error?.message ?? "Apply failed — nothing was written.",
      );
    }
  }, [pendingPlan, sessionId, onApplied]);

  const cancelPending = useCallback(() => {
    setPendingPlan(null);
    setApplyError(null);
  }, []);

  /* S9 manual review: trust the node's SKILL.md at its current content. The
     agentd endpoint hashes under the workspace lock, so what gets recorded is
     exactly what is on disk at review time. */
  const doTrust = useCallback(
    async (node: BlueprintNode) => {
      const dir = node.path.slice(0, node.path.lastIndexOf("/"));
      setTrustBusy(true);
      const res = await reviewTrust(`${dir}/SKILL.md`, sessionId);
      setTrustBusy(false);
      if (res.ok) {
        setNotice("Trusted — the skill loads in new terminals.");
        setNoticeRestart(true);
        void load();
      } else {
        setApplyError(res.error ?? "Could not record the review.");
      }
    },
    [sessionId, load],
  );

  if (!visible) return null;

  return (
    <div style={s.wrap}>
      <div style={s.main}>
        <div style={s.toolbar}>
          <span style={s.title}>Blueprint</span>
          <div style={s.toolRight}>
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
            {graph?.initialized && (
              <button
                style={{ ...s.newBtn, ...(newMenu ? s.newBtnActive : null) }}
                onClick={() => setNewMenu((v) => !v)}
                disabled={kinds.length === 0}
                title={
                  kinds.length === 0
                    ? "No creatable kinds available"
                    : "Scaffold a new resource"
                }
              >
                + New
              </button>
            )}
            {onToggleArchitect && (
              <button
                style={{
                  ...s.newBtn,
                  ...(architectOpen ? s.newBtnActive : null),
                }}
                onClick={onToggleArchitect}
                title="Ask the Architect to propose changes to this blueprint"
              >
                Architect
              </button>
            )}
          </div>
        </div>

        {newMenu && graph?.initialized && (
          <div style={s.newRow}>
            <select
              style={s.newSelect}
              value={newKind}
              onChange={(e) => setNewKind(e.target.value)}
            >
              {kinds.map((k) => (
                <option key={k.kind} value={k.kind}>
                  {k.kind}
                </option>
              ))}
            </select>
            <input
              style={s.newInput}
              placeholder="Name (e.g. Code Review)"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitNewNode();
                if (e.key === "Escape") setNewMenu(false);
              }}
              autoFocus
            />
            <button
              style={s.newCreate}
              onClick={submitNewNode}
              disabled={!newName.trim()}
            >
              Plan…
            </button>
          </div>
        )}

        {applyError && !pendingPlan && (
          <div style={s.banner}>
            {applyError}
            <button style={s.bannerClose} onClick={() => setApplyError(null)}>
              ✕
            </button>
          </div>
        )}

        {notice && !applyError && (
          <div style={s.banner}>
            <span style={s.bannerText}>
              {notice}
              {noticeRestart && onRestartAgents && (
                <button
                  style={s.bannerAction}
                  onClick={() => {
                    onRestartAgents();
                    setNotice(null);
                    setNoticeRestart(false);
                  }}
                >
                  Restart agent now
                </button>
              )}
            </span>
            <button
              style={s.bannerClose}
              onClick={() => {
                setNotice(null);
                setNoticeRestart(false);
              }}
            >
              ✕
            </button>
          </div>
        )}

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
            onConnect={onConnect}
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
          onTrust={(n) => void doTrust(n)}
          trustBusy={trustBusy}
        />
      )}

      {pendingPlan && (
        <PlanPreview
          plan={pendingPlan}
          busy={applyBusy}
          error={applyError}
          onApply={applyPending}
          onCancel={cancelPending}
        />
      )}
    </div>
  );
}

const s: Record<string, CSSProperties> = {
  wrap: { flex: 1, minHeight: 0, display: "flex", position: "relative" },
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
  toolRight: { display: "inline-flex", alignItems: "center", gap: "0.6rem" },
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
  newBtn: {
    font: "inherit",
    fontSize: "0.72rem",
    fontWeight: 600,
    color: "var(--ink)",
    background: "none",
    border: "1px solid var(--ink)",
    borderRadius: "var(--radius-pill)",
    padding: "0.1rem 0.7rem",
    cursor: "pointer",
  },
  newBtnActive: { background: "var(--ink)", color: "var(--paper)" },
  newRow: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    padding: "0.5rem 0.85rem",
    borderBottom: "1px solid var(--rule)",
    background: "var(--paper-sunken)",
  },
  newSelect: {
    font: "inherit",
    fontSize: "0.78rem",
    color: "var(--ink)",
    background: "var(--paper)",
    border: "1px solid var(--rule-strong)",
    borderRadius: "var(--radius-sm)",
    padding: "0.2rem 0.4rem",
  },
  newInput: {
    flex: 1,
    minWidth: 0,
    font: "inherit",
    fontSize: "0.78rem",
    color: "var(--ink)",
    background: "var(--paper)",
    border: "1px solid var(--rule-strong)",
    borderRadius: "var(--radius-sm)",
    padding: "0.2rem 0.5rem",
  },
  newCreate: {
    font: "inherit",
    fontSize: "0.78rem",
    fontWeight: 600,
    color: "var(--paper)",
    background: "var(--ink)",
    border: "none",
    borderRadius: "var(--radius-pill)",
    padding: "0.25rem 0.9rem",
    cursor: "pointer",
  },
  banner: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "0.75rem",
    padding: "0.5rem 0.85rem",
    borderBottom: "1px solid var(--rule)",
    background: "var(--paper-sunken)",
    color: "var(--ink)",
    fontSize: "0.8rem",
  },
  bannerText: {
    display: "inline-flex",
    alignItems: "center",
    gap: "0.75rem",
    flexWrap: "wrap",
  },
  bannerAction: {
    font: "inherit",
    fontSize: "0.76rem",
    fontWeight: 600,
    color: "var(--paper)",
    background: "var(--ink)",
    border: "none",
    borderRadius: "var(--radius-pill)",
    padding: "0.2rem 0.8rem",
    cursor: "pointer",
  },
  bannerClose: {
    background: "none",
    border: "none",
    color: "var(--ink-muted)",
    cursor: "pointer",
    fontSize: "0.8rem",
    lineHeight: 1,
    padding: "0.1rem 0.3rem",
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
