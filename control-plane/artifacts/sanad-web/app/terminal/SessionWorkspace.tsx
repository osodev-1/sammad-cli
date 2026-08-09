"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import ArtifactsStrip from "./ArtifactsStrip";
import BrowserPanel from "./BrowserPanel";
import FileTree from "./FileTree";
import UsageDock from "./UsageDock";
import TerminalPanel, { type TerminalPhase } from "./TerminalPanel";
import {
  FilePreview,
  GRAPH_TAB_ID,
  TabsBar,
  type BrowserTab,
  type TerminalTabInfo,
  type WorkspaceTab,
} from "./tabs";
import GraphPanel from "./graph/GraphPanel";
import ArchitectPanel from "./architect/ArchitectPanel";
import WorkspaceContextHeader from "./WorkspaceContextHeader";
import {
  buildTree,
  detectArtifacts,
  isBrowserViewable,
  withSession,
  type WsEntry,
} from "@/lib/terminal/workspace-model";
import type { ThemeMode } from "@/lib/terminal/xtermTheme";
import { loadDefaultSession, persistSessionState } from "@/lib/sessions/client";
import { SESSION_STATE_VERSION } from "@/lib/sessions/state";

const POLL_MS = 4000;
const MAX_TERMINALS = 3;

/**
 * One session's entire pane: Files sidebar, tabbed main area (terminals +
 * previews), artifacts strip. The parent mounts this KEYED BY SESSION — a
 * session switch remounts everything scoped to that session's machine, and
 * the terminals adopt that machine's detached agents (ring-buffer replay).
 */
export default function SessionWorkspace({
  sessionId,
  projectName,
  themeMode,
  onStatusPhase,
}: {
  sessionId?: string;
  projectName?: string;
  themeMode: ThemeMode;
  onStatusPhase?: (phase: TerminalPhase) => void;
}) {
  const [entries, setEntries] = useState<WsEntry[]>([]);
  const [polling, setPolling] = useState(false);
  const [terminals, setTerminals] = useState<TerminalTabInfo[]>([
    { id: "term-1", label: "Terminal" },
  ]);
  const [fileTabs, setFileTabs] = useState<WorkspaceTab[]>([]);
  const [viewTabs, setViewTabs] = useState<BrowserTab[]>([]);
  const [active, setActive] = useState<string>("term-1");
  const [phases, setPhases] = useState<Record<string, TerminalPhase>>({});
  const [notice, setNotice] = useState<string | null>(null);
  /* Bottom drawer: a plain shell in this session's directory. Mounted on
     first open, then kept alive (hidden) so the shell survives the drawer. */
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerMounted, setDrawerMounted] = useState(false);
  const toggleDrawer = useCallback(() => {
    setDrawerMounted(true);
    setDrawerOpen((prev) => !prev);
  }, []);
  const sessionStart = useRef<number>(Date.now() / 1000);
  const termCounter = useRef(1);
  const viewCounter = useRef(0);

  /* PRD Session persistence: restore this project's open tabs/drawer on mount,
     then save them (debounced) as they change. sessionId here is the project
     (machine) id; prdSessionId is the restorable work-state record. */
  const prdSessionId = useRef<string | null>(null);
  const hydrated = useRef(false);
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    (async () => {
      const loaded = await loadDefaultSession(sessionId);
      if (cancelled || !loaded) {
        hydrated.current = true; // nothing to restore; allow saves
        return;
      }
      prdSessionId.current = loaded.id;
      const s = loaded.uiState;
      if (s.terminals.length > 0) {
        setTerminals(s.terminals);
        const maxN = Math.max(
          1,
          ...s.terminals.map((t) => Number(t.id.replace("term-", "")) || 0),
        );
        termCounter.current = maxN;
      }
      if (s.fileTabs.length > 0) {
        setFileTabs(
          s.fileTabs.map((t) => ({
            path: t.path,
            name: t.path.split("/").pop() ?? t.path,
          })),
        );
      }
      if (s.viewTabs.length > 0) {
        setViewTabs(
          s.viewTabs.map((t, i) => ({
            id: `view-${i + 1}`,
            url: t.url,
            title: t.alias ?? (t.url.split("/").pop() || t.url),
          })),
        );
        viewCounter.current = s.viewTabs.length;
      }
      if (s.drawerOpen) {
        setDrawerMounted(true);
        setDrawerOpen(true);
      }
      if (s.active) setActive(s.active);
      hydrated.current = true;
    })();
    return () => {
      cancelled = true;
    };
    // sessionId (the project) is fixed for this mount — restore runs once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  /* While the session machine is waking (snapshot 503s), back off instead
     of hammering every tick — the first success resets to normal cadence. */
  const snapshotFails = useRef(0);
  const snapshotNextAt = useRef(0);

  const refresh = useCallback(
    async (force = false) => {
      if (!force && Date.now() < snapshotNextAt.current) return;
      setPolling(true);
      try {
        const res = await fetch(
          withSession("/api/workspace/snapshot", sessionId),
        );
        if (res.ok) {
          snapshotFails.current = 0;
          snapshotNextAt.current = 0;
          const body = await res.json();
          const next: WsEntry[] | undefined = body?.data?.entries;
          if (Array.isArray(next)) setEntries(next);
        } else {
          snapshotFails.current += 1;
          const backoff = Math.min(
            POLL_MS * 2 ** snapshotFails.current,
            30_000,
          );
          snapshotNextAt.current = Date.now() + backoff;
        }
      } catch {
        /* transient — next poll will retry */
      } finally {
        setPolling(false);
      }
    },
    [sessionId],
  );

  /* Poll while the page is visible; the Page Visibility API pauses it. */
  useEffect(() => {
    void refresh(true);
    const tick = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const timer = window.setInterval(tick, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  /* The moment a terminal connects the machine is definitely up — skip any
     pending backoff so the file tree fills in right away. */
  useEffect(() => {
    if (Object.values(phases).some((p) => p.tag === "live")) void refresh(true);
  }, [phases, refresh]);

  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 5000);
    return () => window.clearTimeout(t);
  }, [notice]);

  /* Persist restorable state (debounced) once hydrated — never before, so the
     initial empty render can't clobber a saved session before it loads. */
  useEffect(() => {
    if (!hydrated.current || !prdSessionId.current || !sessionId) return;
    const timer = window.setTimeout(() => {
      void persistSessionState(sessionId, prdSessionId.current!, {
        v: SESSION_STATE_VERSION,
        terminals,
        fileTabs: fileTabs.map((t) => ({ path: t.path })),
        viewTabs: viewTabs.map((t) => ({ url: t.url, alias: t.title })),
        active,
        drawerOpen,
      });
    }, 800);
    return () => window.clearTimeout(timer);
  }, [terminals, fileTabs, viewTabs, active, drawerOpen, sessionId]);

  const tree = useMemo(() => buildTree(entries), [entries]);
  const artifacts = useMemo(
    () => detectArtifacts(entries, sessionStart.current),
    [entries],
  );

  const isTerminalActive = terminals.some((t) => t.id === active);
  const activeView = viewTabs.find((v) => v.id === active) ?? null;
  const graphActive = active === GRAPH_TAB_ID;
  /* The Architect chat is a pane WITHIN the Blueprint tab (it edits the graph,
     so the graph stays in view), toggled open/closed rather than a tab. */
  const [architectOpen, setArchitectOpen] = useState(false);

  /* Cross-focus: selecting a .sanad manifest file in the tree highlights its
     node when the graph is open. The id convention mirrors the kernel's:
     folder name under a kind dir → "<prefix>:<slug>". */
  const [graphFocus, setGraphFocus] = useState<string | null>(null);
  const openGraph = useCallback(() => setActive(GRAPH_TAB_ID), []);

  /* Paths the file tree should reveal — set to a fresh array after each apply
     so the FileTree re-runs its expand effect even for a repeated path. */
  const [revealPaths, setRevealPaths] = useState<string[]>([]);

  /* Epoch for the agent terminals — bumped after a server-side restart so the
     panels remount and reconnect (the fresh spawn resumes the conversation). */
  const [termEpoch, setTermEpoch] = useState(0);

  /* S9 activation: the CLI discovers skills at construction, so applying a new
     definition needs a fresh agent process to take effect. Kill the machine's
     agent PTYs, then remount the panels; the first respawn resumes the newest
     conversation from disk — same chat, freshly loaded (trust-gated) skills.
     The drawer shell is a different kind and is never touched. */
  const restartAgents = useCallback(async () => {
    try {
      const res = await fetch(withSession("/api/terminal/restart", sessionId), {
        method: "POST",
      });
      if (!res.ok) throw new Error("restart failed");
      setTermEpoch((e) => e + 1);
      setNotice("Agent restarted — same conversation, updated blueprint.");
    } catch {
      setNotice("Could not restart the agent — try again in a moment.");
    }
  }, [sessionId]);

  const openFile = useCallback((path: string) => {
    const name = path.split("/").pop() ?? path;
    setFileTabs((prev) =>
      prev.some((t) => t.path === path) ? prev : [...prev, { path, name }],
    );
    setActive(path);
    // Opening a .sanad manifest also cross-focuses its graph node (GR-005).
    if (path.startsWith(".sanad/")) setGraphFocus(path);
  }, []);

  /* A blueprint apply (from the graph's authoring menu or the Architect) just
     wrote files to the machine — so the machine is definitely up. Force the
     snapshot past any wake-backoff, and reveal the written paths in the tree so
     they surface immediately instead of hiding in collapsed `.sanad` folders. */
  const onBlueprintApplied = useCallback(
    (writtenPaths: string[]) => {
      void refresh(true);
      setRevealPaths([...writtenPaths]);
    },
    [refresh],
  );

  const viewTitle = (url: string): string => {
    if (/^https?:\/\//i.test(url)) {
      try {
        return new URL(url).host;
      } catch {
        return url;
      }
    }
    return url.split("/").pop() || url;
  };

  /* Updaters stay pure — companion setActive happens alongside (the #185 lesson). */
  const openInBrowser = useCallback(
    (pathOrUrl: string) => {
      const existing = viewTabs.find((v) => v.url === pathOrUrl);
      if (existing) {
        setActive(existing.id);
        return;
      }
      viewCounter.current += 1;
      const tab: BrowserTab = {
        id: `view-${viewCounter.current}`,
        url: pathOrUrl,
        title: viewTitle(pathOrUrl),
      };
      setViewTabs((prev) =>
        prev.some((v) => v.url === pathOrUrl) ? prev : [...prev, tab],
      );
      setActive(tab.id);
    },
    [viewTabs],
  );

  const closeView = useCallback(
    (id: string) => {
      setViewTabs((prev) => prev.filter((v) => v.id !== id));
      setActive((current) => (current === id ? terminals[0].id : current));
    },
    [terminals],
  );

  const navigateView = useCallback((id: string, nextUrl: string) => {
    setViewTabs((prev) =>
      prev.map((v) =>
        v.id === id ? { ...v, url: nextUrl, title: viewTitle(nextUrl) } : v,
      ),
    );
  }, []);

  const closeFile = useCallback(
    (path: string) => {
      setFileTabs((prev) => prev.filter((t) => t.path !== path));
      setActive((current) => (current === path ? terminals[0].id : current));
    },
    [terminals],
  );

  /* State updaters stay PURE — companion state changes happen alongside,
     never inside another setState's updater. */
  const addTerminal = useCallback(() => {
    if (terminals.length >= MAX_TERMINALS) return;
    termCounter.current += 1;
    const id = `term-${termCounter.current}`;
    setTerminals((prev) =>
      prev.length >= MAX_TERMINALS
        ? prev
        : [...prev, { id, label: `Terminal ${termCounter.current}` }],
    );
    setActive(id);
  }, [terminals.length]);

  const closeTerminal = useCallback(
    (id: string) => {
      if (terminals.length <= 1) return;
      const next = terminals.filter((t) => t.id !== id);
      setTerminals(next);
      setPhases((p) => {
        const { [id]: _dropped, ...rest } = p;
        return rest;
      });
      setActive((current) =>
        current === id ? next[next.length - 1].id : current,
      );
    },
    [terminals],
  );

  /* Identity-stable phase sink; skips no-op updates so a panel re-reporting
     the same phase never re-renders the shell. */
  const reportPhase = useCallback((id: string, p: TerminalPhase) => {
    setPhases((prev) => {
      const existing = prev[id];
      if (
        existing &&
        existing.tag === p.tag &&
        JSON.stringify(existing) === JSON.stringify(p)
      ) {
        return prev;
      }
      return { ...prev, [id]: p };
    });
  }, []);

  /* Files opened as tabs may be deleted/renamed by the agent — drop them. */
  useEffect(() => {
    if (!entries.length) return;
    const known = new Set(entries.map((e) => e.path));
    setFileTabs((prev) => {
      const next = prev.filter((t) => known.has(t.path));
      return next.length === prev.length ? prev : next;
    });
    setActive((current) =>
      current === GRAPH_TAB_ID ||
      terminals.some((t) => t.id === current) ||
      viewTabs.some((v) => v.id === current) ||
      known.has(current)
        ? current
        : terminals[0].id,
    );
  }, [entries, terminals, viewTabs]);

  /* The active terminal's state, lifted for the status bar + session dot. */
  const statusPhase: TerminalPhase = phases[
    isTerminalActive ? active : terminals[0].id
  ] ?? { tag: "connecting" };
  const onStatusPhaseRef = useRef(onStatusPhase);
  onStatusPhaseRef.current = onStatusPhase;
  useEffect(() => {
    onStatusPhaseRef.current?.(statusPhase);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by tag identity
  }, [statusPhase.tag]);

  return (
    <>
      <aside style={s.sidebar} className="nav-hide-sm">
        <WorkspaceContextHeader
          projectName={projectName ?? "Workspace"}
          sessionId={sessionId}
          onChanged={() => void refresh(true)}
        />
        <div style={s.treeScroll}>
          <FileTree
            sessionId={sessionId}
            tree={tree}
            busy={polling}
            onOpenFile={openFile}
            onOpenInBrowser={openInBrowser}
            onRefresh={() => void refresh(true)}
            onError={setNotice}
            revealPaths={revealPaths}
          />
        </div>
        {/* Month-to-date allowance, docked at the foot of the sidebar where the
            agent is actively spending it (US-001..006). */}
        <UsageDock />
      </aside>
      <main style={s.main}>
        <TabsBar
          terminals={terminals}
          viewTabs={viewTabs}
          fileTabs={fileTabs}
          active={active}
          canAddTerminal={terminals.length < MAX_TERMINALS}
          onSelect={setActive}
          onCloseFile={closeFile}
          onCloseTerminal={closeTerminal}
          onCloseView={closeView}
          onNewTerminal={addTerminal}
          onOpenGraph={openGraph}
        />
        <div style={s.panelArea}>
          {/* Terminals stay MOUNTED across tab switches — hidden, never unmounted.
              No window chrome: the terminal is a pane of the page, not a card. */}
          {terminals.map((t) => (
            <div
              /* termEpoch remounts the panel after a server-side agent restart
                 (S9): the old PTY is gone, so reconnecting spawns fresh. */
              key={`${t.id}:${termEpoch}`}
              style={{
                ...s.terminalPane,
                ...(active === t.id ? null : s.paneHidden),
              }}
            >
              <TerminalPanel
                visible={active === t.id}
                themeMode={themeMode}
                sessionId={sessionId}
                onPhaseChange={(p) => reportPhase(t.id, p)}
              />
            </div>
          ))}
          {activeView && (
            <BrowserPanel
              key={activeView.id}
              url={activeView.url}
              sessionId={sessionId}
              onNavigate={(u) => navigateView(activeView.id, u)}
            />
          )}
          {/* Blueprint pane: the graph and the Architect chat side by side.
              The architect edits the blueprint, so the graph stays in view;
              the chat is a collapsible pane, not a separate tab (M3c). Kept
              mounted while hidden so both survive tab switches, and the
              architect keeps its conversation when collapsed. */}
          <div style={graphActive ? s.graphPane : s.paneHidden}>
            <div style={s.blueprintSplit}>
              <div style={s.blueprintGraph}>
                <GraphPanel
                  sessionId={sessionId}
                  visible={graphActive}
                  onOpenFile={openFile}
                  onApplied={onBlueprintApplied}
                  onRestartAgents={restartAgents}
                  focusResourceId={graphFocus}
                  architectOpen={architectOpen}
                  onToggleArchitect={() => setArchitectOpen((v) => !v)}
                />
              </div>
              <div
                style={architectOpen ? s.blueprintArchitect : s.architectHidden}
              >
                <ArchitectPanel
                  sessionId={sessionId}
                  visible={graphActive && architectOpen}
                  onApplied={onBlueprintApplied}
                  onRestartAgents={restartAgents}
                />
              </div>
            </div>
          </div>
          {!isTerminalActive && !activeView && !graphActive && active && (
            <FilePreview key={active} path={active} sessionId={sessionId} />
          )}
        </div>
        <div style={s.drawer}>
          <button type="button" style={s.drawerBar} onClick={toggleDrawer}>
            <span style={s.drawerTitle}>Terminal</span>
            <span style={s.drawerChevron}>{drawerOpen ? "▾" : "▴"}</span>
          </button>
          {drawerMounted && (
            <div
              style={{
                ...s.drawerBody,
                ...(drawerOpen ? null : s.drawerClosed),
              }}
            >
              <TerminalPanel
                visible={drawerOpen}
                themeMode={themeMode}
                sessionId={sessionId}
                shell
              />
            </div>
          )}
        </div>
        <ArtifactsStrip
          artifacts={artifacts}
          sessionId={sessionId}
          onOpen={(p) =>
            isBrowserViewable(p) ? openInBrowser(p) : openFile(p)
          }
        />
      </main>
      {notice && <div style={s.notice}>{notice}</div>}
    </>
  );
}

const s: Record<string, CSSProperties> = {
  sidebar: {
    width: "250px",
    minWidth: "250px",
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
  },
  treeScroll: {
    flex: 1,
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
  },
  main: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
  },
  panelArea: {
    flex: 1,
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
    position: "relative",
  },
  graphPane: {
    position: "absolute",
    inset: 0,
    display: "flex",
    flexDirection: "column",
  },
  blueprintSplit: { flex: 1, minHeight: 0, display: "flex" },
  blueprintGraph: { flex: 1, minWidth: 0, display: "flex" },
  blueprintArchitect: {
    width: "400px",
    minWidth: "320px",
    display: "flex",
    borderLeft: "1px solid var(--rule-strong)",
  },
  architectHidden: { display: "none" },
  terminalPane: {
    flex: 1,
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
  },
  paneHidden: {
    position: "absolute",
    inset: 0,
    visibility: "hidden",
    pointerEvents: "none",
  },
  notice: {
    position: "fixed",
    bottom: "3rem",
    left: "50%",
    transform: "translateX(-50%)",
    zIndex: 400,
    background: "var(--ink)",
    color: "var(--paper)",
    borderRadius: "var(--radius-pill)",
    padding: "0.5rem 1.2rem",
    fontSize: "0.82rem",
  },
  drawer: {
    display: "flex",
    flexDirection: "column",
    borderTop: "1px solid var(--rule)",
  },
  drawerBar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    width: "100%",
    padding: "0.3rem 1rem",
    background: "var(--paper)",
    border: "none",
    cursor: "pointer",
    fontFamily: "var(--font-mono)",
    fontSize: "0.66rem",
    fontWeight: 600,
    letterSpacing: "0.12em",
    textTransform: "uppercase",
    color: "var(--ink-muted)",
  },
  drawerTitle: {},
  drawerChevron: { fontSize: "0.7rem" },
  drawerBody: {
    height: "220px",
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
  },
  drawerClosed: {
    height: 0,
    overflow: "hidden",
  },
};
