"use client";

import { useCallback, useEffect, useState } from "react";
import type { CSSProperties } from "react";
import Nav from "../ui/Nav";
import { MoonIcon, SunIcon } from "../ui/icons";
import SessionPanel, { type WorkspaceSessionInfo } from "./SessionPanel";
import SessionWorkspace from "./SessionWorkspace";
import StatusBar from "./StatusBar";
import type { TerminalPhase } from "./TerminalPanel";
import {
  persistThemeMode,
  readThemeMode,
  type ThemeMode,
} from "@/lib/terminal/xtermTheme";

/**
 * The Sanad workspace shell. Sessions are projects — each with its own
 * machine, directory tree and agent history. The selected session's entire
 * pane (files, terminals, previews, artifacts) mounts keyed by session id;
 * switching sessions swaps the whole pane.
 */
export default function WorkspaceClient({ plan }: { plan: string }) {
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

  /* ------------------------------------------------------------ sessions --- */
  const [sessions, setSessions] = useState<WorkspaceSessionInfo[]>([]);
  const [sessionLimit, setSessionLimit] = useState(5);
  const [activeSessionId, setActiveSessionId] = useState<string | undefined>();
  const [paneStatus, setPaneStatus] = useState<TerminalPhase>({ tag: "connecting" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/sessions");
        if (!res.ok) return; // legacy compute — the pane runs unscoped
        const body = await res.json();
        const rows: WorkspaceSessionInfo[] | undefined = body?.data?.sessions;
        if (cancelled || !Array.isArray(rows) || rows.length === 0) return;
        if (typeof body?.data?.limit === "number") setSessionLimit(body.data.limit);
        setSessions(rows);
        let initial = rows[0].id;
        try {
          const remembered = window.localStorage.getItem("sanad-ws-active-session");
          if (remembered && rows.some((r) => r.id === remembered)) initial = remembered;
        } catch {
          /* storage blocked */
        }
        setActiveSessionId(initial);
      } catch {
        /* network hiccup — the pane still renders unscoped */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const selectSession = useCallback((id: string) => {
    setActiveSessionId(id);
    setPaneStatus({ tag: "connecting" });
    try {
      window.localStorage.setItem("sanad-ws-active-session", id);
    } catch {
      /* storage blocked */
    }
  }, []);

  const createSession = useCallback(
    async (name: string) => {
      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(body?.error?.message ?? "Could not create the session");
      }
      const session: WorkspaceSessionInfo = body.data.session;
      setSessions((prev) => [...prev, session]);
      selectSession(session.id);
    },
    [selectSession]
  );

  const renameSession = useCallback(async (id: string, name: string) => {
    setSessions((prev) => prev.map((r) => (r.id === id ? { ...r, name } : r)));
    await fetch(`/api/sessions/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    }).catch(() => {
      /* the optimistic label stays; the next load resyncs */
    });
  }, []);

  /* Session controller pane — collapse state survives reloads. */
  const [sessionsCollapsed, setSessionsCollapsed] = useState(false);
  useEffect(() => {
    try {
      setSessionsCollapsed(window.localStorage.getItem("sanad-ws-sessions") === "collapsed");
    } catch {
      /* storage blocked — default open */
    }
  }, []);
  const toggleSessions = useCallback(() => {
    setSessionsCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem("sanad-ws-sessions", next ? "collapsed" : "open");
      } catch {
        /* storage blocked */
      }
      return next;
    });
  }, []);

  const onStatusPhase = useCallback((p: TerminalPhase) => {
    setPaneStatus((prev) => (prev.tag === p.tag ? prev : p));
  }, []);

  return (
    <div style={s.root} data-ws-theme={themeMode}>
      <Nav
        links={[
          { href: "/dashboard", label: "Dashboard" },
          { href: "/pricing", label: "Pricing", compactHidden: true },
        ]}
        planBadge={plan}
        brandExtra={
          <button
            type="button"
            style={s.themeToggle}
            onClick={toggleTheme}
            title={themeMode === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            aria-label={themeMode === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          >
            {themeMode === "dark" ? <SunIcon size={16} /> : <MoonIcon size={16} />}
          </button>
        }
      />
      <div style={s.grid}>
        {/* Keyed by session: switching remounts the pane against that
            session's machine; its agents re-adopt and replay. */}
        <SessionWorkspace
          key={activeSessionId ?? "default"}
          sessionId={activeSessionId}
          themeMode={themeMode}
          onStatusPhase={onStatusPhase}
        />
        {sessions.length > 0 && (
          <div className="nav-hide-sm" style={s.rightPane}>
            <SessionPanel
              sessions={sessions}
              activeId={activeSessionId}
              activePhase={paneStatus}
              canAdd={sessions.length < sessionLimit}
              collapsed={sessionsCollapsed}
              onSelect={selectSession}
              onRename={renameSession}
              onCreate={createSession}
              onToggleCollapsed={toggleSessions}
            />
          </div>
        )}
      </div>
      <StatusBar phase={paneStatus} />
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
  rightPane: {
    display: "flex",
    minHeight: 0,
  },
  themeToggle: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "32px",
    height: "32px",
    marginLeft: "0.9rem",
    background: "none",
    border: "1px solid var(--rule-strong)",
    borderRadius: "999px",
    color: "var(--ink-muted)",
    cursor: "pointer",
    transition: "color 0.15s ease, border-color 0.15s ease",
  },
};
