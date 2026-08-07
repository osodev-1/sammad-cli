"use client";

import { useEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent } from "react";
import type { TerminalPhase } from "./TerminalPanel";
import { PanelRightIcon, PencilIcon, PlusIcon, RefreshIcon } from "../ui/icons";

export interface WorkspaceSessionInfo {
  id: string;
  name: string;
  state: string;
}

/**
 * The session controller: each session is a project on its own machine —
 * sleeping costs nothing; selecting one swaps the entire workspace pane.
 * Collapses to a slim rail so the terminal keeps the width.
 */
export default function SessionPanel({
  sessions,
  activeId,
  activePhase,
  canAdd,
  collapsed,
  onSelect,
  onRename,
  onCreate,
  onRestart,
  onToggleCollapsed,
}: {
  sessions: WorkspaceSessionInfo[];
  activeId?: string;
  activePhase: TerminalPhase;
  canAdd: boolean;
  collapsed: boolean;
  onSelect: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onCreate: (name: string) => Promise<void>;
  onRestart: (id: string) => void;
  onToggleCollapsed: () => void;
}) {
  const [editing, setEditing] = useState<{ id: string; draft: string } | null>(null);
  const [creating, setCreating] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const createRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing?.id]); // eslint-disable-line react-hooks/exhaustive-deps -- select once per edit target
  useEffect(() => {
    if (creating !== null) createRef.current?.focus();
  }, [creating !== null]); // eslint-disable-line react-hooks/exhaustive-deps -- focus once per open

  const commitRename = () => {
    if (!editing) return;
    const name = editing.draft.trim();
    if (name) onRename(editing.id, name.slice(0, 40));
    setEditing(null);
  };
  const commitCreate = async () => {
    const name = creating?.trim();
    if (!name) {
      setCreating(null);
      return;
    }
    try {
      await onCreate(name.slice(0, 40));
      setCreating(null);
      setCreateError(null);
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : "Could not create the session");
    }
  };
  const onRenameKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") commitRename();
    else if (e.key === "Escape") setEditing(null);
  };
  const onCreateKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") void commitCreate();
    else if (e.key === "Escape") {
      setCreating(null);
      setCreateError(null);
    }
  };

  if (collapsed) {
    return (
      <aside style={s.rail}>
        <button
          type="button"
          style={s.railButton}
          onClick={onToggleCollapsed}
          title="Show sessions"
          aria-label="Show sessions"
        >
          <PanelRightIcon size={16} />
        </button>
        <span style={s.railCount}>{sessions.length}</span>
      </aside>
    );
  }

  const dotFor = (id: string): CSSProperties => {
    if (id !== activeId) return s.dot; // other machines may be asleep — quiet
    if (activePhase.tag === "live") return { ...s.dot, ...s.dotLive };
    if (activePhase.tag === "connecting" || activePhase.tag === "reconnecting") {
      return { ...s.dot, ...s.dotConnecting };
    }
    return s.dot;
  };

  return (
    <aside style={s.pane}>
      <div style={s.header}>
        <span style={s.title}>Sessions</span>
        <button
          type="button"
          style={s.iconButton}
          onClick={onToggleCollapsed}
          title="Hide sessions"
          aria-label="Hide sessions"
        >
          <PanelRightIcon size={15} />
        </button>
      </div>

      <div style={s.list}>
        {sessions.map((row) => {
          const isActive = row.id === activeId;
          const isEditing = editing?.id === row.id;
          return (
            <div
              key={row.id}
              style={{ ...s.row, ...(isActive ? s.rowActive : null) }}
              onClick={() => !isEditing && onSelect(row.id)}
              onDoubleClick={() => setEditing({ id: row.id, draft: row.name })}
            >
              <span
                style={dotFor(row.id)}
                title={isActive ? activePhase.tag : "session"}
              />
              {isEditing ? (
                <input
                  ref={inputRef}
                  style={s.input}
                  value={editing.draft}
                  maxLength={40}
                  onChange={(e) => setEditing({ id: row.id, draft: e.target.value })}
                  onBlur={commitRename}
                  onKeyDown={onRenameKey}
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <span style={s.label} title={row.name}>
                  {row.name}
                </span>
              )}
              {!isEditing && (
                <span style={s.rowActions}>
                  <button
                    type="button"
                    style={s.iconButton}
                    title="Rename session"
                    aria-label={`Rename ${row.name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setEditing({ id: row.id, draft: row.name });
                    }}
                  >
                    <PencilIcon size={13} />
                  </button>
                  <button
                    type="button"
                    style={s.iconButton}
                    title="Restart machine — picks up platform updates; files and history persist"
                    aria-label={`Restart ${row.name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onRestart(row.id);
                    }}
                  >
                    <RefreshIcon size={13} />
                  </button>
                </span>
              )}
            </div>
          );
        })}
      </div>

      {creating !== null ? (
        <div style={s.createRow}>
          <input
            ref={createRef}
            style={s.input}
            placeholder="Session name"
            value={creating}
            maxLength={40}
            onChange={(e) => setCreating(e.target.value)}
            onKeyDown={onCreateKey}
            onBlur={() => void commitCreate()}
          />
          {createError && <span style={s.createError}>{createError}</span>}
        </div>
      ) : (
        <button
          type="button"
          style={{ ...s.newButton, ...(canAdd ? null : s.newDisabled) }}
          onClick={() => setCreating("")}
          disabled={!canAdd}
          title={canAdd ? "New session — its own machine and files" : "Session limit reached"}
        >
          <PlusIcon size={14} />
          New session
        </button>
      )}
    </aside>
  );
}

const s: Record<string, CSSProperties> = {
  pane: {
    width: "218px",
    minWidth: "218px",
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
    borderLeft: "1px solid var(--rule)",
    background: "var(--paper)",
  },
  rail: {
    width: "36px",
    minWidth: "36px",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "0.5rem",
    paddingTop: "0.55rem",
    borderLeft: "1px solid var(--rule)",
    background: "var(--paper)",
  },
  railButton: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "26px",
    height: "26px",
    background: "none",
    border: "none",
    borderRadius: "var(--radius-sm)",
    color: "var(--ink-muted)",
    cursor: "pointer",
  },
  railCount: {
    fontFamily: "var(--font-mono)",
    fontSize: "0.62rem",
    color: "var(--ink-muted)",
    border: "1px solid var(--rule-strong)",
    borderRadius: "999px",
    padding: "0.05rem 0.4rem",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "0.55rem 0.6rem 0.45rem 0.85rem",
    borderBottom: "1px solid var(--rule)",
  },
  title: {
    fontFamily: "var(--font-mono)",
    fontSize: "0.68rem",
    fontWeight: 600,
    letterSpacing: "0.12em",
    textTransform: "uppercase",
    color: "var(--ink-muted)",
  },
  list: {
    flex: 1,
    minHeight: 0,
    overflowY: "auto",
    padding: "0.35rem",
    display: "flex",
    flexDirection: "column",
    gap: "2px",
  },
  row: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    padding: "0.4rem 0.5rem",
    borderRadius: "var(--radius-sm)",
    cursor: "pointer",
    color: "var(--ink-soft)",
    fontSize: "0.82rem",
    lineHeight: 1.3,
  },
  rowActive: {
    background: "var(--paper-sunken)",
    color: "var(--ink)",
  },
  dot: {
    width: "7px",
    height: "7px",
    flexShrink: 0,
    borderRadius: "999px",
    border: "1px solid var(--ink-muted)",
  },
  dotLive: { background: "var(--ink)", borderColor: "var(--ink)" },
  dotConnecting: { borderStyle: "dashed" },
  label: {
    flex: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  rowActions: {
    display: "inline-flex",
    alignItems: "center",
    gap: "2px",
  },
  iconButton: {
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
    padding: 0,
  },
  input: {
    flex: 1,
    minWidth: 0,
    font: "inherit",
    fontSize: "0.82rem",
    color: "var(--ink)",
    background: "var(--paper)",
    border: "1px solid var(--rule-strong)",
    borderRadius: "var(--radius-sm)",
    padding: "0.15rem 0.35rem",
    outline: "none",
  },
  createRow: {
    display: "flex",
    flexDirection: "column",
    gap: "0.3rem",
    margin: "0.45rem",
  },
  createError: {
    fontSize: "0.72rem",
    color: "var(--ink-muted)",
  },
  newButton: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "0.4rem",
    margin: "0.45rem",
    padding: "0.45rem 0.6rem",
    background: "none",
    border: "1px solid var(--rule-strong)",
    borderRadius: "var(--radius-pill)",
    color: "var(--ink-soft)",
    fontSize: "0.8rem",
    fontWeight: 600,
    cursor: "pointer",
  },
  newDisabled: { opacity: 0.45, cursor: "not-allowed" },
};
