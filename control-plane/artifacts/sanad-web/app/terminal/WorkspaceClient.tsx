"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import Nav from "../ui/Nav";
import ArtifactsStrip from "./ArtifactsStrip";
import BrowserPanel from "./BrowserPanel";
import FileTree from "./FileTree";
import StatusBar from "./StatusBar";
import TerminalPanel, { type TerminalPhase } from "./TerminalPanel";
import {
  FilePreview,
  TabsBar,
  type BrowserTab,
  type TerminalTabInfo,
  type WorkspaceTab,
} from "./tabs";
import {
  buildTree,
  detectArtifacts,
  isBrowserViewable,
  type WsEntry,
} from "@/lib/terminal/workspace-model";
import {
  persistThemeMode,
  readThemeMode,
  type ThemeMode,
} from "@/lib/terminal/xtermTheme";

const POLL_MS = 4000;
const MAX_TERMINALS = 3;

/**
 * The Sanad workspace shell: Files sidebar, tabbed main area (terminals +
 * previews), artifacts strip, status bar. The terminal is one panel — the
 * surrounding app owns the experience. Up to MAX_TERMINALS live terminals;
 * each is its own agent session.
 */
export default function WorkspaceClient({ plan }: { plan: string }) {
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
  /* SSR renders light; the stored/OS preference applies right after mount
     (before first paint of the terminal, which loads async anyway). */
  const [themeMode, setThemeMode] = useState<ThemeMode>("light");
  useEffect(() => {
    setThemeMode(readThemeMode());
  }, []);
  const toggleTheme = useCallback(() => {
    setThemeMode((prev) => {
      const next = prev === "dark" ? "light" : "dark";
      persistThemeMode(next);
      return next;
    });
  }, []);
  const sessionStart = useRef<number>(Date.now() / 1000);
  const termCounter = useRef(1);
  const viewCounter = useRef(0);

  /* While the workspace machine is waking (snapshot 503s), back off instead
     of hammering every tick — the first success resets to normal cadence. */
  const snapshotFails = useRef(0);
  const snapshotNextAt = useRef(0);

  const refresh = useCallback(async (force = false) => {
    if (!force && Date.now() < snapshotNextAt.current) return;
    setPolling(true);
    try {
      const res = await fetch("/api/workspace/snapshot");
      if (res.ok) {
        snapshotFails.current = 0;
        snapshotNextAt.current = 0;
        const body = await res.json();
        const next: WsEntry[] | undefined = body?.data?.entries;
        if (Array.isArray(next)) setEntries(next);
      } else {
        snapshotFails.current += 1;
        const backoff = Math.min(POLL_MS * 2 ** snapshotFails.current, 30_000);
        snapshotNextAt.current = Date.now() + backoff;
      }
    } catch {
      /* transient — next poll will retry */
    } finally {
      setPolling(false);
    }
  }, []);

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

  /* The moment a terminal connects the workspace is definitely up — skip any
     pending backoff so the file tree fills in right away. */
  useEffect(() => {
    if (Object.values(phases).some((p) => p.tag === "live")) void refresh(true);
  }, [phases, refresh]);

  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 5000);
    return () => window.clearTimeout(t);
  }, [notice]);

  const tree = useMemo(() => buildTree(entries), [entries]);
  const artifacts = useMemo(
    () => detectArtifacts(entries, sessionStart.current),
    [entries]
  );

  const isTerminalActive = terminals.some((t) => t.id === active);
  const activeView = viewTabs.find((v) => v.id === active) ?? null;

  const openFile = useCallback((path: string) => {
    const name = path.split("/").pop() ?? path;
    setFileTabs((prev) =>
      prev.some((t) => t.path === path) ? prev : [...prev, { path, name }]
    );
    setActive(path);
  }, []);

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
        prev.some((v) => v.url === pathOrUrl) ? prev : [...prev, tab]
      );
      setActive(tab.id);
    },
    [viewTabs]
  );

  const closeView = useCallback(
    (id: string) => {
      setViewTabs((prev) => prev.filter((v) => v.id !== id));
      setActive((current) => (current === id ? terminals[0].id : current));
    },
    [terminals]
  );

  const navigateView = useCallback((id: string, nextUrl: string) => {
    setViewTabs((prev) =>
      prev.map((v) => (v.id === id ? { ...v, url: nextUrl, title: viewTitle(nextUrl) } : v))
    );
  }, []);

  const closeFile = useCallback(
    (path: string) => {
      setFileTabs((prev) => prev.filter((t) => t.path !== path));
      setActive((current) => (current === path ? terminals[0].id : current));
    },
    [terminals]
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
        : [...prev, { id, label: `Terminal ${termCounter.current}` }]
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
      setActive((current) => (current === id ? next[next.length - 1].id : current));
    },
    [terminals]
  );

  /* Identity-stable phase sink; skips no-op updates so a panel re-reporting
     the same phase never re-renders the shell. */
  const reportPhase = useCallback((id: string, p: TerminalPhase) => {
    setPhases((prev) => {
      const existing = prev[id];
      if (existing && existing.tag === p.tag && JSON.stringify(existing) === JSON.stringify(p)) {
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
      terminals.some((t) => t.id === current) ||
      viewTabs.some((v) => v.id === current) ||
      known.has(current)
        ? current
        : terminals[0].id
    );
  }, [entries, terminals, viewTabs]);

  /* Status bar shows the active terminal's state (or the first one's). */
  const statusPhase: TerminalPhase =
    phases[isTerminalActive ? active : terminals[0].id] ?? { tag: "connecting" };

  return (
    <div style={s.root} data-ws-theme={themeMode}>
      <Nav
        links={[
          { href: "/dashboard", label: "Dashboard" },
          { href: "/pricing", label: "Pricing", compactHidden: true },
        ]}
        planBadge={plan}
      />
      <div style={s.grid}>
        <aside style={s.sidebar} className="nav-hide-sm">
          <FileTree
            tree={tree}
            busy={polling}
            onOpenFile={openFile}
            onOpenInBrowser={openInBrowser}
            onRefresh={() => void refresh()}
            onError={setNotice}
          />
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
          />
          <div style={s.panelArea}>
            {/* Terminals stay MOUNTED across tab switches — hidden, never unmounted.
                No window chrome: the terminal is a pane of the page, not a card. */}
            {terminals.map((t) => (
              <div
                key={t.id}
                style={{
                  ...s.terminalPane,
                  ...(active === t.id ? null : s.paneHidden),
                }}
              >
                <TerminalPanel
                  visible={active === t.id}
                  themeMode={themeMode}
                  onPhaseChange={(p) => reportPhase(t.id, p)}
                />
              </div>
            ))}
            {activeView && (
              <BrowserPanel
                key={activeView.id}
                url={activeView.url}
                onNavigate={(u) => navigateView(activeView.id, u)}
              />
            )}
            {!isTerminalActive && !activeView && active && (
              <FilePreview key={active} path={active} />
            )}
          </div>
          <ArtifactsStrip
            artifacts={artifacts}
            onOpen={(p) => (isBrowserViewable(p) ? openInBrowser(p) : openFile(p))}
          />
        </main>
      </div>
      <StatusBar phase={statusPhase} themeMode={themeMode} onToggleTheme={toggleTheme} />
      {notice && <div style={s.notice}>{notice}</div>}
    </div>
  );
}

const s: Record<string, CSSProperties> = {
  root: {
    height: "100dvh",
    display: "flex",
    flexDirection: "column",
    background: "var(--paper)",
    overflow: "hidden",
  },
  grid: {
    flex: 1,
    minHeight: 0,
    display: "flex",
  },
  sidebar: {
    width: "250px",
    minWidth: "250px",
    minHeight: 0,
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
};
