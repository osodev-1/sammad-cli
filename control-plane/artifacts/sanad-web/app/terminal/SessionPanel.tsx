"use client";

import { useEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent } from "react";
import type { TerminalPhase } from "./TerminalPanel";
import type { TerminalTabInfo } from "./tabs";
import { CrossOutlineIcon, PanelRightIcon, PencilIcon, PlusIcon } from "../ui/icons";

/**
 * The session controller: every terminal session by name, its live state, and
 * the controls to open, rename, focus and close them. Collapses to a slim
 * rail so the terminal keeps the width when you don't need it.
 */
export default function SessionPanel({
  sessions,
  phases,
  activeId,
  canAdd,
  collapsed,
  onSelect,
  onRename,
  onNew,
  onClose,
  onToggleCollapsed,
}: {
  sessions: TerminalTabInfo[];
  phases: Record<string, TerminalPhase>;
  activeId: string;
  canAdd: boolean;
  collapsed: boolean;
  onSelect: (id: string) => void;
  onRename: (id: string, label: string) => void;
  onNew: () => void;
  onClose: (id: string) => void;
  onToggleCollapsed: () => void;
}) {
  const [editing, setEditing] = useState<{ id: string; draft: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing?.id]); // eslint-disable-line react-hooks/exhaustive-deps -- select once per edit target

  const commit = () => {
    if (!editing) return;
    const label = editing.draft.trim();
    if (label) onRename(editing.id, label.slice(0, 40));
    setEditing(null);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") commit();
    else if (e.key === "Escape") setEditing(null);
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
        {sessions.map((t) => {
          const phase = phases[t.id];
          const live = phase?.tag === "live";
          const connecting =
            phase?.tag === "connecting" || phase?.tag === "reconnecting";
          const isActive = t.id === activeId;
          const isEditing = editing?.id === t.id;
          return (
            <div
              key={t.id}
              style={{ ...s.row, ...(isActive ? s.rowActive : null) }}
              onClick={() => !isEditing && onSelect(t.id)}
              onDoubleClick={() => setEditing({ id: t.id, draft: t.label })}
            >
              <span
                style={{
                  ...s.dot,
                  ...(live ? s.dotLive : null),
                  ...(connecting ? s.dotConnecting : null),
                }}
                title={live ? "live" : connecting ? "connecting" : "offline"}
              />
              {isEditing ? (
                <input
                  ref={inputRef}
                  style={s.input}
                  value={editing.draft}
                  maxLength={40}
                  onChange={(e) => setEditing({ id: t.id, draft: e.target.value })}
                  onBlur={commit}
                  onKeyDown={onKey}
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <span style={s.label} title={t.label}>
                  {t.label}
                </span>
              )}
              {!isEditing && (
                <span style={s.rowActions}>
                  <button
                    type="button"
                    style={s.iconButton}
                    title="Rename session"
                    aria-label={`Rename ${t.label}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setEditing({ id: t.id, draft: t.label });
                    }}
                  >
                    <PencilIcon size={13} />
                  </button>
                  {sessions.length > 1 && (
                    <button
                      type="button"
                      style={s.iconButton}
                      title="Close session"
                      aria-label={`Close ${t.label}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onClose(t.id);
                      }}
                    >
                      <CrossOutlineIcon size={13} />
                    </button>
                  )}
                </span>
              )}
            </div>
          );
        })}
      </div>

      <button
        type="button"
        style={{ ...s.newButton, ...(canAdd ? null : s.newDisabled) }}
        onClick={onNew}
        disabled={!canAdd}
        title={canAdd ? "New session" : "Session limit reached"}
      >
        <PlusIcon size={14} />
        New session
      </button>
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
