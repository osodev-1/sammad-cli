"use client";

import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import {
  fetchCoderConversations,
  type CoderConversationSummary,
} from "@/lib/coder/client";
import { conversationSwitcherLabel } from "@/lib/coder/queueLabels";

/**
 * Minimal conversation switcher (P6a Task 4) — a `<select>` in the Coder
 * panel header listing this workspace's conversations, plus a "+ New"
 * action. Deliberately NOT the P6b tab bar: one control, one dropdown, no
 * per-tab badges or dock section. Selecting a different conversation (or
 * creating one) is handled entirely by the parent (SessionWorkspace) —
 * this component only reports intent (`onSelect`/`onCreate`); it owns
 * nothing about which conversation is "active" beyond `activeId`.
 *
 * Fetches the list on mount and whenever `sessionId`/`activeId` changes
 * (the latter covers "a switch/create just happened" without a poll loop —
 * P6a is the minimal cut, so no live-refresh timer here).
 */
export default function ConversationSwitcher({
  sessionId,
  activeId,
  onSelect,
  onCreate,
  creating,
}: {
  sessionId?: string;
  /** The conversation this panel is currently showing — undefined before
   * the first one is known (e.g. still starting). */
  activeId?: string;
  onSelect: (conversationId: string) => void;
  onCreate: () => void;
  /** True while a "New conversation" request is in flight — disables the
   * control so a double-click can't fire two creates. */
  creating?: boolean;
}) {
  const [conversations, setConversations] = useState<CoderConversationSummary[]>([]);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetchCoderConversations(sessionId).then((list) => {
      if (cancelled) return;
      if (list === null) {
        setLoadFailed(true);
        return;
      }
      setLoadFailed(false);
      setConversations(list);
    });
    return () => {
      cancelled = true;
    };
    // activeId deliberately watched too: a just-created/just-switched-to id
    // that this fetch hasn't caught up to yet re-triggers a refetch once
    // the parent adopts it.
  }, [sessionId, activeId]);

  // The active conversation may not be in `conversations` yet (a fetch
  // still in flight right after creating one, or a transient failure) —
  // synthesize a placeholder option so the <select>'s value always matches
  // a real option instead of silently falling back to the first one.
  const known = activeId && conversations.some((c) => c.conversationId === activeId);
  const options = known || !activeId
    ? conversations
    : [
        { conversationId: activeId, alive: true, busy: false, turn: null },
        ...conversations,
      ];

  return (
    <div style={s.wrap}>
      <select
        style={s.select}
        aria-label="Switch conversation"
        value={activeId ?? ""}
        disabled={creating || options.length === 0}
        onChange={(e) => {
          const next = e.target.value;
          if (next && next !== activeId) onSelect(next);
        }}
      >
        {activeId ? null : <option value="">Starting…</option>}
        {options.map((c) => (
          <option key={c.conversationId} value={c.conversationId}>
            {conversationSwitcherLabel(c)}
          </option>
        ))}
      </select>
      <button
        type="button"
        style={s.newBtn}
        onClick={onCreate}
        disabled={creating}
        title="Start a new conversation"
      >
        {creating ? "Starting…" : "+ New"}
      </button>
      {loadFailed && <span style={s.notice}>could not load the list</span>}
    </div>
  );
}

const s: Record<string, CSSProperties> = {
  wrap: {
    display: "inline-flex",
    alignItems: "center",
    gap: "0.4rem",
    marginLeft: "auto",
  },
  select: {
    font: "inherit",
    fontSize: "0.72rem",
    color: "var(--ink)",
    background: "var(--paper)",
    border: "1px solid var(--rule-strong)",
    borderRadius: "var(--radius-sm)",
    padding: "0.15rem 0.4rem",
    maxWidth: "160px",
  },
  newBtn: {
    font: "inherit",
    fontSize: "0.72rem",
    fontWeight: 600,
    color: "var(--ink)",
    background: "var(--paper)",
    border: "1px solid var(--rule-strong)",
    borderRadius: "var(--radius-pill)",
    padding: "0.15rem 0.55rem",
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  notice: {
    fontSize: "0.65rem",
    color: "var(--ink-muted)",
  },
};
