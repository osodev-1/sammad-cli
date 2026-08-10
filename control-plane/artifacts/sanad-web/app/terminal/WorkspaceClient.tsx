"use client";

import { useCallback, useEffect, useState } from "react";
import type { CSSProperties } from "react";
import Nav from "../ui/Nav";
import { MoonIcon, SunIcon } from "../ui/icons";

import SessionWorkspace, {
  type WorkspaceSessionInfo,
} from "./SessionWorkspace";
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
  const [paneStatus, setPaneStatus] = useState<TerminalPhase>({
    tag: "connecting",
  });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/sessions");
        if (!res.ok) return; // legacy compute — the pane runs unscoped
        const body = await res.json();
        const rows: WorkspaceSessionInfo[] | undefined = body?.data?.sessions;
        if (cancelled || !Array.isArray(rows) || rows.length === 0) return;
        if (typeof body?.data?.limit === "number")
          setSessionLimit(body.data.limit);
        setSessions(rows);
        let initial = rows[0].id;
        try {
          const remembered = window.localStorage.getItem(
            "sanad-ws-active-session",
          );
          if (remembered && rows.some((r) => r.id === remembered))
            initial = remembered;
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
    [selectSession],
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

  /* Reboot a session's machine (files/history persist). Restarting the one
     on screen remounts its pane so it dials the fresh machine immediately. */
  const [paneEpoch, setPaneEpoch] = useState(0);
  const restartSession = useCallback(
    async (id: string) => {
      await fetch(`/api/sessions/${encodeURIComponent(id)}/restart`, {
        method: "POST",
      }).catch(() => {
        /* the machine may already be asleep — the next wake is fresh anyway */
      });
      if (id === activeSessionId) {
        setPaneStatus({ tag: "connecting" });
        setPaneEpoch((e) => e + 1);
      }
    },
    [activeSessionId],
  );

  /* Delete a project: the server cascades (machine stopped, files
     unreachable, project-born CLI sessions revoked) — the client just
     resyncs the list and moves off the deleted project if it was on screen. */
  const deleteSession = useCallback(
    async (id: string) => {
      const res = await fetch(`/api/sessions/${encodeURIComponent(id)}`, {
        method: "DELETE",
      }).catch(() => null);
      if (!res?.ok) return; // the panel keeps the row; the next load resyncs
      const remaining = sessions.filter((r) => r.id !== id);
      setSessions(remaining);
      // Deleting the on-screen project switches to the first remaining one;
      // deleting the last reloads (the list endpoint auto-creates "main").
      if (id === activeSessionId) {
        if (remaining[0]) selectSession(remaining[0].id);
        else window.location.reload();
      }
    },
    [sessions, activeSessionId, selectSession],
  );

  const onStatusPhase = useCallback((p: TerminalPhase) => {
    setPaneStatus((prev) => (prev.tag === p.tag ? prev : p));
  }, []);

  return (
    <div style={s.root} data-ws-theme={themeMode}>
      <Nav
        links={[
          { href: "/projects", label: "Projects" },
          { href: "/dashboard", label: "Dashboard" },
          { href: "/pricing", label: "Pricing", compactHidden: true },
        ]}
        planBadge={plan}
        brandExtra={
          <button
            type="button"
            style={s.themeToggle}
            onClick={toggleTheme}
            title={
              themeMode === "dark"
                ? "Switch to light mode"
                : "Switch to dark mode"
            }
            aria-label={
              themeMode === "dark"
                ? "Switch to light mode"
                : "Switch to dark mode"
            }
          >
            {themeMode === "dark" ? (
              <SunIcon size={16} />
            ) : (
              <MoonIcon size={16} />
            )}
          </button>
        }
      />
      <div style={s.grid}>
        {/* Keyed by session: switching remounts the pane against that
            session's machine; its agents re-adopt and replay. */}
        <SessionWorkspace
          key={`${activeSessionId ?? "default"}:${paneEpoch}`}
          sessionId={activeSessionId}
          projectName={sessions.find((x) => x.id === activeSessionId)?.name}
          themeMode={themeMode}
          onStatusPhase={onStatusPhase}
          projectControls={{
            projects: sessions,
            activeId: activeSessionId,
            limit: sessionLimit,
            onSelect: selectSession,
            onCreate: createSession,
            onRestart: restartSession,
            onDelete: deleteSession,
          }}
        />
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
