/**
 * Pure label helpers for the write-lease queue reason and lease status
 * (P6a Task 4) — split out of CoderPanel.tsx so the mapping is unit-testable
 * without mounting the panel. Nothing here does I/O; every function is a
 * plain data-in/string-out mapping.
 */

/** One item in the server-side follow-up queue (P4b), as `/turn`'s `queue`
 * field returns it. `reason`/`blockedBy` are P6a Task 3 additions — both
 * optional, so an ordinary queued item (no lease contention involved) is
 * untouched. Mirrors `CoderTurnState["queue"]`'s element type
 * (lib/coder/types.ts) structurally rather than importing it, so this
 * module stays a leaf with no dependency on the wire types. */
export interface QueueEntryLike {
  reason?: string;
  blockedBy?: string;
}

/** `/turn`'s `"lease"` field (P6a Task 3's `_lease_summary`) — workspace-
 * scoped, not conversation-scoped. `kind` is `null` when nobody holds the
 * lease, `"conversation"` when a real conversation does (see `holder`), or
 * `"revert"` when a human-triggered revert does (`holder` stays `null` in
 * that case: the server deliberately never surfaces the raw internal
 * `"__revert__"` holder id here — see `_lease_summary`'s docstring). */
export interface LeaseLike {
  kind: "conversation" | "revert" | null;
  holder: string | null;
}

/** Short, human-legible tag for a conversation id — ids are long
 * (`c_<hex>`); the last 8 characters are enough to tell two conversations
 * apart in a casual label without dumping the whole id into the UI. */
export function shortConversationId(cid: string): string {
  return cid.length > 8 ? cid.slice(-8) : cid;
}

/** The QueueStrip's per-item label (P6a Task 4). A plain queued item (no
 * `reason`) keeps today's plain "queued" tag. A `waiting_for_lease` item
 * names the conversation it's blocked on when the server supplied one
 * (`blockedBy`), or falls back to a generic "waiting for another
 * conversation" when it didn't — never blank, and never implying it's
 * waiting on nothing. Any other/future `reason` value also falls back to
 * the generic queued label rather than rendering an unrecognized string
 * verbatim. */
/** Conversation ids are minted as `c_<hex>` (12 hex chars today, per the
 * server's own CONVERSATION_ID_RE). Anything else — notably the internal
 * `__revert__` lease sentinel — must never be rendered as one. The backend
 * already strips it, so this is defence in depth at the render boundary:
 * the cost is one regex, the failure it prevents is a user being told they
 * are "waiting for conversation revert__".
 *
 * Deliberately NOT pinned to exactly 12 characters. This guard exists to
 * reject a sentinel, not to validate an id — so it accepts any `c_`+hex
 * shape. Pinning the current length would mean that changing the id format
 * silently downgrades every real "waiting for conversation X" label to the
 * generic fallback, which is a worse failure than the one being prevented
 * and would be invisible in testing. */
function isConversationId(id: string): boolean {
  return /^c_[a-f0-9]+$/.test(id);
}

export function queueEntryLabel(entry: QueueEntryLike): string {
  if (entry.reason === "waiting_for_revert") {
    return "waiting for a revert to finish";
  }
  if (entry.reason === "waiting_for_lease") {
    return entry.blockedBy && isConversationId(entry.blockedBy)
      ? `waiting for conversation ${shortConversationId(entry.blockedBy)}`
      : "waiting for another conversation";
  }
  return "queued";
}

/** The composer/queue-strip's lease status line (P6a Tasks 3+4). Returns
 * `null` when there is nothing worth saying: no lease is held, the reading
 * is missing entirely (an older server / a transient fetch gap), or the
 * lease is held by THIS conversation's own running turn (already conveyed
 * by the panel's existing "Coding…" status strip — repeating it here would
 * be noise). A revert never names a conversation, by construction: this
 * function only ever branches on `lease.kind`, so a `"revert"` reading can
 * never surface the raw holder sentinel even if one leaked through. */
export function leaseStatusLabel(
  lease: LeaseLike | null | undefined,
  ownConversationId?: string,
): string | null {
  if (!lease || lease.kind == null) return null;
  if (lease.kind === "revert") {
    return "A revert is in progress — new turns will wait until it finishes.";
  }
  // lease.kind === "conversation"
  if (!lease.holder || lease.holder === ownConversationId) return null;
  return `Conversation ${shortConversationId(lease.holder)} is running a turn — new turns here will wait.`;
}

/** One row of the conversation switcher's list, as `GET /conversations`
 * returns it (`{conversationId, alive, busy, turn}`). Structural, like
 * `QueueEntryLike` above, to keep this module dependency-free. */
export interface ConversationSummaryLike {
  conversationId: string;
  alive: boolean;
  busy: boolean;
  turn: { status?: string } | null;
}

/** The switcher's short status word per conversation — "running" while a
 * turn is actually in flight (either the server's `busy` flag, or a turn
 * whose last known status is still "running" — the two can momentarily
 * disagree across a poll boundary, so either one is enough), "stopped" once
 * the runner has gone away entirely, "idle" otherwise. */
export function conversationStatusWord(c: ConversationSummaryLike): "running" | "idle" | "stopped" {
  if (!c.alive) return "stopped";
  if (c.busy || c.turn?.status === "running") return "running";
  return "idle";
}

/** The switcher's per-row label: a short id plus its status word, e.g.
 * `"a1b2c3d4 — running"`. Pure formatting so the switcher's `<select>`
 * options are testable without mounting it. */
export function conversationSwitcherLabel(c: ConversationSummaryLike): string {
  return `${shortConversationId(c.conversationId)} — ${conversationStatusWord(c)}`;
}
