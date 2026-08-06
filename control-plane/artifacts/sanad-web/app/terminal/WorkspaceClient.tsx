"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import Nav from "../ui/Nav";
import TerminalFrame from "../ui/TerminalFrame";
import ArtifactsStrip from "./ArtifactsStrip";
import FileTree from "./FileTree";
import StatusBar from "./StatusBar";
import TerminalPanel, { type TerminalPhase } from "./TerminalPanel";
import {
  FilePreview,
  TabsBar,
  type TerminalTabInfo,
  type WorkspaceTab,
} from "./tabs";
import {
  buildTree,
  detectArtifacts,
  type WsEntry,
} from "@/lib/terminal/workspace-model";

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
  const [active, setActive] = useState<string>("term-1");
  const [phases, setPhases] = useState<Record<string, TerminalPhase>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const sessionStart = useRef<number>(Date.now() / 1000);
  const termCounter = useRef(1);

  const refresh = useCallback(async () => {
    setPolling(true);
    try {
      const res = await fetch("/api/workspace/snapshot");
      if (res.ok) {
        const body = await res.json();
        const next: WsEntry[] | undefined = body?.data?.entries;
        if (Array.isArray(next)) setEntries(next);
      }
    } catch {
      /* transient — next poll will retry */
    } finally {
      setPolling(false);
    }
  }, []);

  /* Poll while the page is visible; the Page Visibility API pauses it. */
  useEffect(() => {
    void refresh();
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

  const openFile = useCallback((path: string) => {
    const name = path.split("/").pop() ?? path;
    setFileTabs((prev) =>
      prev.some((t) => t.path === path) ? prev : [...prev, { path, name }]
    );
    setActive(path);
  }, []);

  const closeFile = useCallback(
    (path: string) => {
      setFileTabs((prev) => prev.filter((t) => t.path !== path));
      setActive((current) => (current === path ? terminals[0].id : current));
    },
    [terminals]
  );

  const addTerminal = useCallback(() => {
    setTerminals((prev) => {
      if (prev.length >= MAX_TERMINALS) return prev;
      termCounter.current += 1;
      const id = `term-${termCounter.current}`;
      setActive(id);
      return [...prev, { id, label: `Terminal ${termCounter.current}` }];
    });
  }, []);

  const closeTerminal = useCallback((id: string) => {
    setTerminals((prev) => {
      if (prev.length <= 1) return prev;
      const next = prev.filter((t) => t.id !== id);
      setActive((current) => (current === id ? next[next.length - 1].id : current));
      setPhases((p) => {
        const { [id]: _dropped, ...rest } = p;
        return rest;
      });
      return next;
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
      terminals.some((t) => t.id === current) || known.has(current)
        ? current
        : terminals[0].id
    );
  }, [entries, terminals]);

  /* Status bar shows the active terminal's state (or the first one's). */
  const statusPhase: TerminalPhase =
    phases[isTerminalActive ? active : terminals[0].id] ?? { tag: "connecting" };

  return (
    <div style={s.root}>
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
            onRefresh={() => void refresh()}
            onError={setNotice}
          />
        </aside>
        <main style={s.main}>
          <TabsBar
            terminals={terminals}
            fileTabs={fileTabs}
            active={active}
            canAddTerminal={terminals.length < MAX_TERMINALS}
            onSelect={setActive}
            onCloseFile={closeFile}
            onCloseTerminal={closeTerminal}
            onNewTerminal={addTerminal}
          />
          <div style={s.panelArea}>
            {/* Terminals stay MOUNTED across tab switches — hidden, never unmounted. */}
            {terminals.map((t) => (
              <TerminalFrame
                key={t.id}
                title={
                  t.label === "Terminal"
                    ? "sanad — workspace"
                    : `sanad — ${t.label.toLowerCase()}`
                }
                style={{
                  ...s.terminalFrame,
                  ...(active === t.id ? null : s.frameHidden),
                }}
              >
                <TerminalPanel
                  visible={active === t.id}
                  onPhaseChange={(p) =>
                    setPhases((prev) => ({ ...prev, [t.id]: p }))
                  }
                />
              </TerminalFrame>
            ))}
            {!isTerminalActive && active && (
              <FilePreview key={active} path={active} />
            )}
          </div>
          <ArtifactsStrip artifacts={artifacts} onOpen={openFile} />
        </main>
      </div>
      <StatusBar phase={statusPhase} />
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
    padding: "0.75rem",
  },
  terminalFrame: {
    flex: 1,
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
    borderRadius: "var(--radius-md)",
  },
  frameHidden: {
    position: "absolute",
    inset: "0.75rem",
    visibility: "hidden",
    pointerEvents: "none",
  },
  notice: {
    position: "fixed",
    bottom: "3rem",
    left: "50%",
    transform: "translateX(-50%)",
    zIndex: 400,
    background: "var(--invert-surface)",
    color: "var(--invert-ink)",
    borderRadius: "var(--radius-pill)",
    padding: "0.5rem 1.2rem",
    fontSize: "0.82rem",
  },
};
