"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import ArtifactsStrip from "./ArtifactsStrip";
import BrowserPanel from "./BrowserPanel";
import FileTree from "./FileTree";
import UsageDock from "./UsageDock";
import TerminalPanel, { type TerminalPhase } from "./TerminalPanel";
import {
  CODER_TAB_ID,
  FilePreview,
  GRAPH_TAB_ID,
  TabsBar,
  type BrowserTab,
  type TerminalTabInfo,
  type WorkspaceTab,
} from "./tabs";
import GraphPanel from "./graph/GraphPanel";
import ContextDock from "./dock/ContextDock";
import ArchitectPanel from "./architect/ArchitectPanel";
import CoderPanel from "./coder/CoderPanel";
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
import {
  SESSION_STATE_VERSION,
  type StoredArchitectMessage,
  type StoredCoderMessage,
} from "@/lib/sessions/state";
import type { CheckpointSummary } from "@/lib/coder/transcript";
import { ensureConversation } from "@/lib/coder/client";

const POLL_MS = 4000;
const MAX_TERMINALS = 3;

export interface WorkspaceSessionInfo {
  id: string;
  name: string;
  state: string;
}

/** Project lifecycle controls, passed down for the header switcher (R4). */
export interface ProjectControls {
  projects: WorkspaceSessionInfo[];
  activeId?: string;
  limit: number;
  onSelect: (id: string) => void;
  onCreate: (name: string) => Promise<void>;
  onRestart: (id: string) => void;
  onDelete: (id: string) => void;
}

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
  coderEnabled = false,
  projectControls,
}: {
  sessionId?: string;
  projectName?: string;
  themeMode: ThemeMode;
  onStatusPhase?: (phase: TerminalPhase) => void;
  coderEnabled?: boolean;
  projectControls?: ProjectControls;
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
  /* Architect chat transcript — rides the PRD-session uiState (restored in the
     hydration effect below, persisted with the other tab state). */
  const [architectTranscript, setArchitectTranscript] = useState<
    StoredArchitectMessage[] | undefined
  >(undefined);
  /* Coder chat (P1b) — same treatment as the architect transcript above, plus
     the conversation id (the machine-side ticket) so a reload re-attaches. */
  const [coderConvId, setCoderConvId] = useState<string | undefined>(
    undefined,
  );
  const [coderTranscript, setCoderTranscript] = useState<
    StoredCoderMessage[] | undefined
  >(undefined);
  /* Restart-recovery idempotency (P3 Task 4 Fix B): the turnId of the last
     "interrupted" turn CoderPanel already surfaced, so a reload doesn't
     re-replay (and re-persist a duplicate of) the same crash-interrupted
     turn — see CoderPanel's `needsInterruptedReplay` guard. */
  const [coderLastInterruptedTurnId, setCoderLastInterruptedTurnId] =
    useState<string | undefined>(undefined);
  /* Checkpoint-bearing turns (P5 Task 4), threaded live from CoderPanel so
     the dock's Checkpoints section can list/Review/Revert them without a
     second fetch of its own — never persisted (rebuilt from CoderPanel's
     own live transcript on every mount). */
  const [coderCheckpoints, setCoderCheckpoints] = useState<
    { turnId: string; checkpoint: CheckpointSummary }[]
  >([]);
  /* Conversation switcher (P6a Task 4) — bumped only on an EXPLICIT switch
     or create (never on CoderPanel's own internal "just minted a fresh
     id" auto-assign, which flows through `onConversationId` alone). Used
     as CoderPanel's `key` below so switching conversations gets a clean
     new instance — fresh refs, fresh polling effects, no risk of a stray
     in-flight update from the OLD conversation's turn bleeding into the
     NEW one's (now-empty) transcript. */
  const [coderEpoch, setCoderEpoch] = useState(0);
  const [creatingConversation, setCreatingConversation] = useState(false);
  /* Context dock (R4): open state persists; reviews + activity feed it. */
  const [dockOpen, setDockOpen] = useState(true);
  const [pendingReviews, setPendingReviews] = useState<string[]>([]);
  const [activityEpoch, setActivityEpoch] = useState(0);
  const prevPendingCount = useRef(0);
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
      if (s.architect && s.architect.length > 0) {
        setArchitectTranscript(s.architect);
      }
      if (s.coder) {
        if (s.coder.conversationId) setCoderConvId(s.coder.conversationId);
        if (s.coder.transcript && s.coder.transcript.length > 0) {
          setCoderTranscript(s.coder.transcript);
        }
        if (s.coder.lastInterruptedTurnId) {
          setCoderLastInterruptedTurnId(s.coder.lastInterruptedTurnId);
        }
      }
      if (s.dockOpen === false) setDockOpen(false);
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
      const hasCoder =
        !!coderConvId || (coderTranscript && coderTranscript.length > 0);
      void persistSessionState(sessionId, prdSessionId.current!, {
        v: SESSION_STATE_VERSION,
        terminals,
        fileTabs: fileTabs.map((t) => ({ path: t.path })),
        viewTabs: viewTabs.map((t) => ({ url: t.url, alias: t.title })),
        active,
        drawerOpen,
        architect: architectTranscript,
        dockOpen,
        ...(hasCoder
          ? {
              coder: {
                conversationId: coderConvId,
                transcript: coderTranscript,
                lastInterruptedTurnId: coderLastInterruptedTurnId,
              },
            }
          : {}),
      });
    }, 800);
    return () => window.clearTimeout(timer);
  }, [
    terminals,
    fileTabs,
    viewTabs,
    active,
    drawerOpen,
    architectTranscript,
    dockOpen,
    coderConvId,
    coderTranscript,
    coderLastInterruptedTurnId,
    sessionId,
  ]);

  const tree = useMemo(() => buildTree(entries), [entries]);
  const artifacts = useMemo(
    () => detectArtifacts(entries, sessionStart.current),
    [entries],
  );

  const isTerminalActive = terminals.some((t) => t.id === active);
  const activeView = viewTabs.find((v) => v.id === active) ?? null;
  const graphActive = active === GRAPH_TAB_ID;
  const coderActive = active === CODER_TAB_ID;
  /* The Architect chat is a pane WITHIN the Blueprint tab (it edits the graph,
     so the graph stays in view), toggled open/closed rather than a tab. */
  const [architectOpen, setArchitectOpen] = useState(false);

  /* Cross-focus: selecting a .sanad manifest file in the tree highlights its
     node when the graph is open. The id convention mirrors the kernel's:
     folder name under a kind dir → "<prefix>:<slug>". */
  const [graphFocus, setGraphFocus] = useState<string | null>(null);
  const openGraph = useCallback(() => setActive(GRAPH_TAB_ID), []);
  const openCoder = useCallback(() => setActive(CODER_TAB_ID), []);

  /* Paths the file tree should reveal — set to a fresh array after each apply
     so the FileTree re-runs its expand effect even for a repeated path. */
  const [revealPaths, setRevealPaths] = useState<string[]>([]);

  /* Epoch for the agent terminals — bumped after a server-side restart so the
     panels remount and reconnect (the fresh spawn resumes the conversation). */
  const [termEpoch, setTermEpoch] = useState(0);

  /* Workspace reset (S9 activation): the CLI discovers skills at
     construction, so the current blueprint only loads into FRESH agent
     processes. Reset = (a) stop the architect subprocess (next ask spawns it
     with fresh auth), (b) kill the machine's agent PTYs, (c) remount the
     panels; the first respawn resumes the newest conversation from disk —
     same chat, current blueprint. The drawer shell is never touched. */
  const resetWorkspace = useCallback(async () => {
    try {
      // Architect reset is best-effort — the machine may not have a runner.
      void fetch(withSession("/api/architect/reset", sessionId), {
        method: "POST",
      }).catch(() => {});
      const res = await fetch(withSession("/api/terminal/restart", sessionId), {
        method: "POST",
      });
      if (!res.ok) throw new Error("restart failed");
      setTermEpoch((e) => e + 1);
      setNotice(
        "Workspace reset — agents restarted with the current blueprint.",
      );
    } catch {
      setNotice("Could not reset the workspace — try again in a moment.");
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
      setActivityEpoch((e) => e + 1); // dock refetches trust + history
    },
    [refresh],
  );

  /* A coder revert (P5 Task 4) just restored the workspace tree to an
     earlier turn's pre-checkpoint — same "the machine is definitely up,
     files just changed under everything that reads them" situation as a
     blueprint apply, minus the reveal (a revert removes/restores files
     already in the tree; there's nothing new to surface). Revert never
     touches the coder turn machine, so nothing else here needs to react. */
  const onCoderReverted = useCallback(() => {
    void refresh(true);
    setActivityEpoch((e) => e + 1); // dock refetches trust + history
  }, [refresh]);

  /* Switch the coder panel to a DIFFERENT conversation (P6a Task 4) — the
     ONLY place `coderConvId` changes outside CoderPanel's own first-mint
     auto-assign (`onConversationId`). Transcript hygiene: the persisted
     `uiState.coder.transcript`/`lastInterruptedTurnId`/checkpoints are all
     single-conversation today (P6b's job to make that per-conversation),
     so switching clears them rather than showing conversation A's history
     under B's tab — CoderPanel rebuilds whatever's live (a running turn,
     pending requests) from the server the moment it remounts for the new
     id. Bumping `coderEpoch` is what forces that remount (see the `key` on
     CoderPanel below) — a same-instance prop swap would leave the OLD
     conversation's in-flight polling/follow closures free to keep writing
     into the NEW (now-cleared) transcript state after the switch. */
  const switchCoderConversation = useCallback(
    (id: string) => {
      // State updaters stay PURE — companion state changes happen
      // alongside, never inside another setState's updater (the #185
      // lesson, see `addTerminal`/`closeTerminal` above): read the current
      // id directly off state rather than nesting these inside
      // `setCoderConvId`'s own updater.
      if (id === coderConvId) return;
      setCoderConvId(id);
      setCoderTranscript(undefined);
      setCoderLastInterruptedTurnId(undefined);
      setCoderCheckpoints([]);
      setCoderEpoch((e) => e + 1);
    },
    [coderConvId],
  );

  /* "New conversation" (P6a Task 4) — mints a ticket and creates, same
     redemption path CoderPanel's own begin() uses (`ensureConversation`
     with no existing id skips straight to create). The one failure this
     surfaces explicitly is `conversation_limit` (the workspace's
     `coder_max_conversations` cap) — reusing the same toast `notice` the
     rest of this component already uses for FileTree/reset errors, so it
     is never silent. */
  const createCoderConversation = useCallback(async () => {
    if (creatingConversation) return;
    setCreatingConversation(true);
    try {
      const res = await ensureConversation(undefined, sessionId);
      if (!res.ok || !res.conversationId) {
        setNotice(res.error ?? "Could not start a new conversation.");
        return;
      }
      switchCoderConversation(res.conversationId);
    } finally {
      setCreatingConversation(false);
    }
  }, [creatingConversation, sessionId, switchCoderConversation]);

  /* "In addition to the main context": a draft landing while the dock is
     hidden (or the user is off the Blueprint tab) gets a toast so it is
     never missed. */
  useEffect(() => {
    const grew = pendingReviews.length > prevPendingCount.current;
    prevPendingCount.current = pendingReviews.length;
    if (grew && (!dockOpen || active !== GRAPH_TAB_ID)) {
      setNotice(
        "The architect drafted a change — it's waiting in the side dock.",
      );
    }
    // dockOpen/active deliberately unwatched: only NEW drafts notify.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingReviews]);

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
      (coderEnabled && current === CODER_TAB_ID) ||
      terminals.some((t) => t.id === current) ||
      viewTabs.some((v) => v.id === current) ||
      known.has(current)
        ? current
        : terminals[0].id,
    );
  }, [entries, terminals, viewTabs, coderEnabled]);

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
          onReset={() => void resetWorkspace()}
          projectControls={projectControls}
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
          showCoder={coderEnabled ?? false}
          onSelect={setActive}
          onCloseFile={closeFile}
          onCloseTerminal={closeTerminal}
          onCloseView={closeView}
          onNewTerminal={addTerminal}
          onOpenGraph={openGraph}
          onOpenCoder={openCoder}
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
                  onRestartAgents={resetWorkspace}
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
                  initial={architectTranscript}
                  onPersist={setArchitectTranscript}
                  onApplied={onBlueprintApplied}
                  onRestartAgents={resetWorkspace}
                  onPendingReviews={setPendingReviews}
                />
              </div>
            </div>
          </div>
          {/* Coder pane: a singleton tab like Blueprint, dark unless the
              caller has the flag (Task 4). Kept mounted while hidden so the
              conversation survives tab switches. */}
          {coderEnabled && (
            <div style={coderActive ? s.coderPane : s.paneHidden}>
              <CoderPanel
                // `coderEpoch` (P6a Task 4): bumped ONLY on an explicit
                // switch/create (see `switchCoderConversation` above),
                // never on CoderPanel's own internal first-mint auto-
                // assign — so the panel remounts fresh exactly when the
                // user picks a different conversation (clean transcript,
                // no stale in-flight closures from the old one), and NOT
                // on every ordinary render.
                key={coderEpoch}
                sessionId={sessionId}
                visible={coderActive}
                conversationId={coderConvId}
                onConversationId={setCoderConvId}
                initial={coderTranscript}
                onPersist={setCoderTranscript}
                lastInterruptedTurnId={coderLastInterruptedTurnId}
                onLastInterruptedTurnId={setCoderLastInterruptedTurnId}
                onCheckpoints={setCoderCheckpoints}
                onReverted={onCoderReverted}
                onSwitchConversation={switchCoderConversation}
                onCreateConversation={() => void createCoderConversation()}
                creatingConversation={creatingConversation}
              />
            </div>
          )}
          {!isTerminalActive &&
            !activeView &&
            !graphActive &&
            !coderActive &&
            active && (
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
      <div className="nav-hide-sm" style={s.dockCol}>
        <ContextDock
          sessionId={sessionId}
          context={graphActive ? "graph" : coderActive ? "coder" : "other"}
          open={dockOpen}
          onToggle={() => setDockOpen((v) => !v)}
          pendingReviews={pendingReviews}
          activityEpoch={activityEpoch}
          onOpenGraph={openGraph}
          coderConversationId={coderConvId}
          coderCheckpoints={coderCheckpoints}
          onCoderReverted={onCoderReverted}
        />
      </div>
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
  coderPane: {
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
  dockCol: { display: "flex", minHeight: 0 },
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
