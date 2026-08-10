"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { GitBranchIcon } from "../ui/icons";
import type { ProjectControls } from "./SessionWorkspace";
import {
  fetchGitBranches,
  fetchGitStatus,
  gitCheckout,
  gitCommit,
  gitCreateBranch,
  gitStash,
  type GitStatus,
} from "@/lib/git/client";

const POLL_MS = 5000;

/**
 * The sticky Git context header (PRD §9.2). Shows the active branch, short
 * SHA, and dirty count for the project, and offers switch / new-branch /
 * commit. A dirty tree blocks a branch switch (WC-007) until the user commits,
 * stashes, or cancels.
 */
export default function WorkspaceContextHeader({
  projectName,
  sessionId,
  onChanged,
  onReset,
  projectControls,
}: {
  projectName: string;
  sessionId?: string;
  onChanged?: () => void;
  /** Workspace reset: restart the agents so the current blueprint loads. */
  onReset?: () => void;
  /** The project switcher (R4) — replaces the retired Projects pane. */
  projectControls?: ProjectControls;
}) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [menu, setMenu] = useState<
    "none" | "branches" | "commit" | "newBranch" | "projects"
  >("none");
  const [branches, setBranches] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    const st = await fetchGitStatus(sessionId);
    setStatus(st);
  }, [sessionId]);

  useEffect(() => {
    void refresh();
    const t = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, POLL_MS);
    return () => window.clearInterval(t);
  }, [refresh]);

  // Close any open menu on an outside click.
  useEffect(() => {
    if (menu === "none") return;
    const onDown = (e: MouseEvent) => {
      if (
        rootRef.current &&
        !rootRef.current.contains(e.target as globalThis.Node)
      ) {
        setMenu("none");
        setError(null);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menu]);

  const openBranches = useCallback(async () => {
    setError(null);
    setMenu("branches");
    const b = await fetchGitBranches(sessionId);
    setBranches(b?.branches ?? []);
  }, [sessionId]);

  const done = useCallback(() => {
    setMenu("none");
    setDraft("");
    setError(null);
    setBusy(false);
    void refresh();
    onChanged?.();
  }, [refresh, onChanged]);

  const switchBranch = useCallback(
    async (name: string) => {
      if (name === status?.branch) return setMenu("none");
      setBusy(true);
      const res = await gitCheckout(name, sessionId);
      if (!res.ok) {
        setBusy(false);
        setError(
          res.code === "dirty_tree"
            ? "Commit or stash your changes before switching."
            : (res.message ?? "Could not switch branch."),
        );
        return;
      }
      done();
    },
    [status?.branch, sessionId, done],
  );

  const commit = useCallback(async () => {
    const message = draft.trim();
    if (!message) return;
    setBusy(true);
    const res = await gitCommit(message, sessionId);
    if (!res.ok) {
      setBusy(false);
      setError(res.message ?? "Commit failed.");
      return;
    }
    done();
  }, [draft, sessionId, done]);

  const createBranch = useCallback(async () => {
    const name = draft.trim();
    if (!name) return;
    setBusy(true);
    const res = await gitCreateBranch(name, sessionId);
    if (!res.ok) {
      setBusy(false);
      setError(res.message ?? "Could not create branch.");
      return;
    }
    done();
  }, [draft, sessionId, done]);

  const stashThenSwitch = useCallback(async () => {
    setBusy(true);
    await gitStash(sessionId);
    setBusy(false);
    setError(null);
    void openBranches();
  }, [sessionId, openBranches]);

  const dirty = (status?.dirtyCount ?? 0) > 0;

  return (
    <div style={s.wrap} ref={rootRef}>
      <div style={s.top}>
        {projectControls ? (
          <button
            type="button"
            style={s.repoBtn}
            title="Switch project"
            onClick={() => setMenu(menu === "projects" ? "none" : "projects")}
          >
            <span style={s.repo}>{projectName}</span>
            <span style={s.repoCaret}>▾</span>
          </button>
        ) : (
          <span style={s.repo} title={projectName}>
            {projectName}
          </span>
        )}
        {onReset && (
          <button
            style={s.resetBtn}
            title="Restart the workspace agents so the current blueprint (skills, definitions) loads into the session"
            onClick={() => {
              if (
                window.confirm(
                  "Reset the workspace? Running agents restart (the conversation resumes) and the current blueprint loads.",
                )
              ) {
                onReset();
              }
            }}
          >
            Reset
          </button>
        )}
      </div>
      <div style={s.row}>
        <button
          style={s.branchBtn}
          onClick={openBranches}
          title="Switch branch"
        >
          <GitBranchIcon size={13} strokeWidth={1.8} />
          <span style={s.branchName}>
            {status?.branch ?? (status?.isRepo ? "—" : "no repo")}
          </span>
        </button>
        {status?.head && <span style={s.sha}>{status.head}</span>}
        {dirty && (
          <button
            style={s.dirty}
            onClick={() => setMenu("commit")}
            title="Commit changes"
          >
            {status?.dirtyCount} change{status?.dirtyCount === 1 ? "" : "s"}
          </button>
        )}
        {(status?.ahead ?? 0) > 0 && (
          <span style={s.track}>↑{status?.ahead}</span>
        )}
        {(status?.behind ?? 0) > 0 && (
          <span style={s.track}>↓{status?.behind}</span>
        )}
      </div>

      {menu === "projects" && projectControls && (
        <div style={s.menu}>
          <div style={s.menuHeader}>
            <span style={s.menuTitle}>Projects</span>
            <button
              style={s.menuAction}
              disabled={
                projectControls.projects.length >= projectControls.limit
              }
              onClick={() => {
                const name = window.prompt("New project name");
                if (name?.trim()) {
                  setMenu("none");
                  void projectControls.onCreate(name.trim().slice(0, 40));
                }
              }}
            >
              + new
            </button>
          </div>
          {projectControls.projects.map((p) => (
            <div key={p.id} style={s.projectRow}>
              <button
                style={{
                  ...s.menuItem,
                  ...(p.id === projectControls.activeId
                    ? s.menuItemActive
                    : null),
                  flex: 1,
                }}
                onClick={() => {
                  setMenu("none");
                  projectControls.onSelect(p.id);
                }}
              >
                {p.name}
              </button>
              <button
                style={s.projectAction}
                title="Restart machine — files and history persist"
                onClick={() => {
                  setMenu("none");
                  projectControls.onRestart(p.id);
                }}
              >
                ↻
              </button>
              <button
                style={s.projectAction}
                title="Delete project — stops its machine, files become unreachable"
                onClick={() => {
                  if (
                    window.confirm(
                      `Delete the project “${p.name}”?\n\nIts machine stops, its files become unreachable, and terminals signed in through it lose access. This cannot be undone.`,
                    )
                  ) {
                    setMenu("none");
                    projectControls.onDelete(p.id);
                  }
                }}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      {menu === "branches" && (
        <div style={s.menu}>
          <div style={s.menuHeader}>
            <span style={s.menuTitle}>Branches</span>
            <button style={s.menuAction} onClick={() => setMenu("newBranch")}>
              + new
            </button>
          </div>
          {branches.length === 0 && (
            <span style={s.menuEmpty}>No branches yet.</span>
          )}
          {branches.map((b) => (
            <button
              key={b}
              style={{
                ...s.menuItem,
                ...(b === status?.branch ? s.menuItemActive : null),
              }}
              onClick={() => switchBranch(b)}
              disabled={busy}
            >
              {b}
            </button>
          ))}
          {error && (
            <div style={s.errorRow}>
              <span style={s.error}>{error}</span>
              <button
                style={s.menuAction}
                onClick={stashThenSwitch}
                disabled={busy}
              >
                stash &amp; retry
              </button>
            </div>
          )}
        </div>
      )}

      {menu === "commit" && (
        <div style={s.menu}>
          <span style={s.menuTitle}>Commit {status?.dirtyCount} change(s)</span>
          <input
            autoFocus
            style={s.input}
            placeholder="Commit message"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void commit();
              else if (e.key === "Escape") setMenu("none");
            }}
          />
          {error && <span style={s.error}>{error}</span>}
          <div style={s.menuButtons}>
            <button style={s.cancel} onClick={() => setMenu("none")}>
              Cancel
            </button>
            <button
              style={s.primary}
              onClick={commit}
              disabled={busy || !draft.trim()}
            >
              Commit
            </button>
          </div>
        </div>
      )}

      {menu === "newBranch" && (
        <div style={s.menu}>
          <span style={s.menuTitle}>New branch</span>
          <input
            autoFocus
            style={s.input}
            placeholder="branch-name"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void createBranch();
              else if (e.key === "Escape") setMenu("none");
            }}
          />
          {error && <span style={s.error}>{error}</span>}
          <div style={s.menuButtons}>
            <button style={s.cancel} onClick={() => setMenu("none")}>
              Cancel
            </button>
            <button
              style={s.primary}
              onClick={createBranch}
              disabled={busy || !draft.trim()}
            >
              Create
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const s: Record<string, CSSProperties> = {
  wrap: {
    position: "relative",
    borderBottom: "1px solid var(--rule)",
    background: "var(--paper)",
    padding: "0.5rem 0.7rem",
  },
  top: {
    marginBottom: "0.35rem",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "0.5rem",
  },
  repoBtn: {
    display: "inline-flex",
    alignItems: "center",
    gap: "0.3rem",
    background: "none",
    border: "none",
    padding: 0,
    cursor: "pointer",
    minWidth: 0,
  },
  repoCaret: { fontSize: "0.6rem", color: "var(--ink-muted)" },
  projectRow: { display: "flex", alignItems: "center", gap: "0.15rem" },
  projectAction: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "22px",
    height: "22px",
    background: "none",
    border: "none",
    borderRadius: "var(--radius-sm)",
    color: "var(--ink-muted)",
    cursor: "pointer",
    fontSize: "0.75rem",
  },
  resetBtn: {
    font: "inherit",
    fontSize: "0.66rem",
    fontWeight: 600,
    color: "var(--ink-muted)",
    background: "none",
    border: "1px solid var(--rule-strong)",
    borderRadius: "var(--radius-pill)",
    padding: "0.1rem 0.55rem",
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  repo: {
    fontSize: "0.82rem",
    fontWeight: 650,
    color: "var(--ink)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    display: "block",
  },
  row: {
    display: "flex",
    alignItems: "center",
    gap: "0.45rem",
    flexWrap: "wrap",
  },
  branchBtn: {
    display: "inline-flex",
    alignItems: "center",
    gap: "0.3rem",
    background: "none",
    border: "1px solid var(--rule-strong)",
    borderRadius: "var(--radius-pill)",
    padding: "0.12rem 0.5rem",
    color: "var(--ink-soft)",
    cursor: "pointer",
    maxWidth: "130px",
  },
  branchName: {
    fontFamily: "var(--font-mono)",
    fontSize: "0.72rem",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  sha: {
    fontFamily: "var(--font-mono)",
    fontSize: "0.68rem",
    color: "var(--ink-muted)",
  },
  dirty: {
    fontFamily: "var(--font-mono)",
    fontSize: "0.68rem",
    color: "var(--ink)",
    background: "var(--paper-sunken)",
    border: "1px solid var(--rule-strong)",
    borderRadius: "var(--radius-pill)",
    padding: "0.1rem 0.5rem",
    cursor: "pointer",
  },
  track: {
    fontFamily: "var(--font-mono)",
    fontSize: "0.68rem",
    color: "var(--ink-muted)",
  },
  menu: {
    position: "absolute",
    top: "100%",
    left: "0.5rem",
    right: "0.5rem",
    zIndex: 50,
    marginTop: "2px",
    background: "var(--paper)",
    border: "1px solid var(--rule-strong)",
    borderRadius: "var(--radius-md)",
    boxShadow: "var(--shadow-soft)",
    padding: "0.5rem",
    display: "flex",
    flexDirection: "column",
    gap: "0.3rem",
  },
  menuHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
  },
  menuTitle: {
    fontFamily: "var(--font-mono)",
    fontSize: "0.62rem",
    letterSpacing: "0.1em",
    textTransform: "uppercase",
    color: "var(--ink-muted)",
  },
  menuAction: {
    background: "none",
    border: "none",
    color: "var(--ink-soft)",
    fontSize: "0.72rem",
    cursor: "pointer",
    textDecoration: "underline",
    textUnderlineOffset: "2px",
  },
  menuEmpty: { fontSize: "0.75rem", color: "var(--ink-muted)" },
  menuItem: {
    textAlign: "left",
    background: "none",
    border: "none",
    borderRadius: "var(--radius-sm)",
    padding: "0.3rem 0.4rem",
    fontFamily: "var(--font-mono)",
    fontSize: "0.76rem",
    color: "var(--ink-soft)",
    cursor: "pointer",
  },
  menuItemActive: { background: "var(--paper-sunken)", color: "var(--ink)" },
  input: {
    font: "inherit",
    fontSize: "0.8rem",
    color: "var(--ink)",
    background: "var(--paper)",
    border: "1px solid var(--rule-strong)",
    borderRadius: "var(--radius-sm)",
    padding: "0.3rem 0.45rem",
    outline: "none",
  },
  menuButtons: { display: "flex", justifyContent: "flex-end", gap: "0.4rem" },
  cancel: {
    background: "none",
    border: "none",
    color: "var(--ink-muted)",
    fontSize: "0.78rem",
    cursor: "pointer",
    padding: "0.2rem 0.5rem",
  },
  primary: {
    background: "var(--ink)",
    color: "var(--paper)",
    border: "none",
    borderRadius: "var(--radius-pill)",
    fontSize: "0.78rem",
    fontWeight: 600,
    padding: "0.25rem 0.8rem",
    cursor: "pointer",
  },
  errorRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "0.4rem",
  },
  error: { fontSize: "0.72rem", color: "var(--ink)", lineHeight: 1.4 },
};
