"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import {
  askArchitect,
  cancelArchitect,
  planFromEvent,
  startArchitect,
  textFromEvent,
  thinkFromEvent,
  toolLabel,
  type ArchitectItem,
} from "@/lib/architect/client";
import {
  fromStored,
  toStored,
  type Block,
  type Message,
} from "@/lib/architect/transcript";
import { applyPlan, fetchCurrentContents, revertTx } from "@/lib/blueprint/api";
import type { StoredArchitectMessage } from "@/lib/sessions/state";
import PlanPreview from "../graph/PlanPreview";

/* Fold one stream item into the in-progress assistant message's blocks. */
function reduce(blocks: Block[], item: ArchitectItem): Block[] {
  const think = thinkFromEvent(item);
  if (think) {
    const last = blocks[blocks.length - 1];
    if (last && last.kind === "think") {
      return [
        ...blocks.slice(0, -1),
        { kind: "think", text: last.text + think },
      ];
    }
    return [...blocks, { kind: "think", text: think }];
  }
  const text = textFromEvent(item);
  if (text) {
    const last = blocks[blocks.length - 1];
    if (last && last.kind === "text") {
      return [...blocks.slice(0, -1), { kind: "text", text: last.text + text }];
    }
    return [...blocks, { kind: "text", text }];
  }
  const label = toolLabel(item);
  if (label) {
    const last = blocks[blocks.length - 1];
    if (last && last.kind === "tool" && last.label === label) return blocks; // dedupe
    return [...blocks, { kind: "tool", label }];
  }
  const plan = planFromEvent(item);
  if (plan) {
    return [
      ...blocks,
      {
        kind: "plan",
        summary: plan.summary,
        files: plan.operations.length,
        edges: plan.graphDelta.edgesAdded.length,
        updated: plan.graphDelta.nodesChanged?.length ?? 0,
        removed:
          (plan.graphDelta.nodesRemoved?.length ?? 0) +
          (plan.graphDelta.edgesRemoved?.length ?? 0),
        state: "pending",
        plan,
      },
    ];
  }
  if (item.kind === "error" && item.code !== "busy") {
    return [
      ...blocks,
      { kind: "text", text: `⚠ ${item.message ?? "Something went wrong."}` },
    ];
  }
  return blocks;
}

const BUSY_RETRY_MS = 4000;
const STALL_AFTER_MS = 90_000;

/**
 * The Architect chat (M3c + S9 hardening). Streams turns from the
 * machine-hosted architect agent; proposals render as review cards whose Apply
 * routes through the same transaction endpoint as manual authoring.
 *
 * Responsive in every state: the composer never locks — messages typed while
 * a turn runs (or while the runner is busy with a turn from a previous page
 * load) queue locally and auto-send when the architect frees up. A watchdog
 * surfaces a Stop control when a turn goes quiet. The transcript persists via
 * the PRD-session uiState, so a dropped session restores the conversation
 * record (earlier drafts expire — the runner's working memory is fresh).
 */
export default function ArchitectPanel({
  sessionId,
  visible,
  initial,
  onPersist,
  onApplied,
  onRestartAgents,
  onPendingReviews,
}: {
  sessionId?: string;
  visible: boolean;
  /** Persisted transcript to restore (from the PRD session's uiState). */
  initial?: StoredArchitectMessage[];
  /** Called (debounced, at turn boundaries) with the serialized transcript. */
  onPersist?: (messages: StoredArchitectMessage[]) => void;
  /** Called after a plan is applied, with the paths it wrote (to reveal them). */
  onApplied?: (writtenPaths: string[]) => void;
  /** Kill + respawn the agent terminals so a new definition loads now (S9). */
  onRestartAgents?: () => void;
  /** Drafts awaiting review (summaries) — feeds the context dock (R4). */
  onPendingReviews?: (summaries: string[]) => void;
}) {
  const [phase, setPhase] = useState<
    "idle" | "starting" | "ready" | "streaming" | "busy" | "error"
  >("idle");
  const [startError, setStartError] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>(() =>
    fromStored(initial ?? []),
  );
  const [restoredCount, setRestoredCount] = useState(
    () => initial?.length ?? 0,
  );
  const [input, setInput] = useState("");
  const [outbox, setOutbox] = useState<{ text: string; retry?: boolean }[]>([]);
  const [stalled, setStalled] = useState(false);
  /* Clicking "Architecting…" reveals the live steps (reasoning + tools). */
  const [showSteps, setShowSteps] = useState(false);
  const [review, setReview] = useState<{ mi: number; bi: number } | null>(null);
  /* Current on-disk text for the reviewed plan's update targets (R2 diffs). */
  const [reviewContents, setReviewContents] = useState<
    Record<string, string> | undefined
  >(undefined);
  const [applyBusy, setApplyBusy] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);

  const startedRef = useRef(false);
  const drainingRef = useRef(false);
  const lastItemAtRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  /* When a review opens, fetch the current on-disk text of its update targets
     so the modal can diff instead of dumping full files (R2). */
  useEffect(() => {
    if (!review) {
      setReviewContents(undefined);
      return;
    }
    const msg = messages[review.mi];
    const block =
      msg && msg.role === "assistant" ? msg.blocks[review.bi] : undefined;
    if (!block || block.kind !== "plan" || !block.plan) return;
    let live = true;
    void fetchCurrentContents(block.plan, sessionId).then((c) => {
      if (live) setReviewContents(c);
    });
    return () => {
      live = false;
    };
    // messages deliberately unwatched: the block is fixed once review opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [review, sessionId]);

  /* If the persisted transcript arrives after mount (hydration race), adopt it
     — but never over a conversation that already started. */
  useEffect(() => {
    if (initial && initial.length > 0 && messages.length === 0) {
      setMessages(fromStored(initial));
      setRestoredCount(initial.length);
    }
    // messages deliberately unwatched: adopt-late only fires from empty.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial]);

  const begin = useCallback(async () => {
    setPhase("starting");
    setStartError(null);
    const res = await startArchitect(sessionId);
    if (res.ok) {
      setPhase("ready");
    } else {
      setPhase("error");
      setStartError(res.error ?? "Could not start the architect.");
      startedRef.current = false; // allow retry
    }
  }, [sessionId]);

  /* Start on first reveal — opening the tab is intent to use it (like a
     terminal), so waking the machine here is expected. */
  useEffect(() => {
    if (visible && !startedRef.current) {
      startedRef.current = true;
      void begin();
    }
  }, [visible, begin]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, outbox]);

  /* Persist at turn boundaries (never per streamed chunk). */
  useEffect(() => {
    if (!onPersist || phase === "streaming" || messages.length === 0) return;
    const t = window.setTimeout(() => onPersist(toStored(messages)), 600);
    return () => window.clearTimeout(t);
  }, [messages, phase, onPersist]);

  /* The dock's Reviews section mirrors the drafts still awaiting action. */
  useEffect(() => {
    if (!onPendingReviews) return;
    const pending = messages.flatMap((m) =>
      m.role === "assistant"
        ? m.blocks
            .filter((b) => b.kind === "plan" && b.state === "pending")
            .map((b) => (b.kind === "plan" ? b.summary : ""))
        : [],
    );
    onPendingReviews(pending);
  }, [messages, onPendingReviews]);

  /* One turn. Two self-healing paths keep the queue moving:
     - "busy": the runner is still on a turn (e.g. from a previous page load)
       — requeue at the front and retry shortly.
     - "turn_failed"/"not_started": the runner's auth died (agentd already
       dropped it, or the process exited) — restart the architect and resend
       the message ONCE; a second failure surfaces as a visible error. */
  const runTurn = useCallback(
    async (text: string, isRetry: boolean) => {
      setPhase("streaming");
      setStalled(false);
      lastItemAtRef.current = Date.now();
      setMessages((m) => [
        ...m,
        { role: "user", text },
        { role: "assistant", blocks: [] },
      ]);
      let busy = false;
      let failed = false;
      await askArchitect(text, sessionId, (item) => {
        lastItemAtRef.current = Date.now();
        setStalled(false);
        if (item.kind === "end") return;
        if (item.kind === "error" && item.code === "busy") {
          busy = true;
          return;
        }
        if (
          item.kind === "error" &&
          (item.code === "turn_failed" || item.code === "not_started")
        ) {
          failed = true;
          // First attempt heals silently (restart + resend); on the retry the
          // error falls through to render, so a real outage stays visible.
          if (!isRetry) return;
        }
        setMessages((prev) => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (last && last.role === "assistant") {
            next[next.length - 1] = {
              role: "assistant",
              blocks: reduce(last.blocks, item),
            };
          }
          return next;
        });
      });
      if (busy) {
        // Roll back the optimistic bubbles; the text waits in the queue.
        setMessages((prev) => prev.slice(0, -2));
        setOutbox((prev) => [{ text, retry: isRetry }, ...prev]);
        setPhase("busy");
      } else if (failed && !isRetry) {
        setMessages((prev) => prev.slice(0, -2));
        setOutbox((prev) => [{ text, retry: true }, ...prev]);
        await begin(); // fresh subprocess, freshly redeemed auth
      } else {
        // A turn that ended with NOTHING (no content, no error item — e.g. a
        // machine still on an older image whose dead turns die silently) must
        // never leave a blank message: explain, and point at the recovery.
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (
            last &&
            last.role === "assistant" &&
            !last.blocks.some((b) => b.kind !== "think")
          ) {
            const next = [...prev];
            next[next.length - 1] = {
              role: "assistant",
              blocks: [
                ...last.blocks,
                {
                  kind: "text",
                  text: "⚠ No response arrived for this turn. If this keeps happening, use Reset (top of the file sidebar) to restart the workspace agents.",
                },
              ],
            };
            return next;
          }
          return prev;
        });
        setPhase("ready");
      }
    },
    [sessionId, begin],
  );

  /* Drain the queue whenever the architect is free. */
  useEffect(() => {
    if (phase !== "ready" || outbox.length === 0 || drainingRef.current) return;
    drainingRef.current = true;
    const [next, ...rest] = outbox;
    setOutbox(rest);
    void runTurn(next.text, next.retry ?? false).finally(() => {
      drainingRef.current = false;
    });
  }, [phase, outbox, runTurn]);

  /* Busy backoff: try again shortly — the earlier turn may have finished. */
  useEffect(() => {
    if (phase !== "busy") return;
    const t = window.setTimeout(() => setPhase("ready"), BUSY_RETRY_MS);
    return () => window.clearTimeout(t);
  }, [phase]);

  /* Watchdog: a turn that has gone quiet gets a visible Stop control. */
  useEffect(() => {
    if (phase !== "streaming") return;
    const t = window.setInterval(() => {
      if (Date.now() - lastItemAtRef.current > STALL_AFTER_MS) setStalled(true);
    }, 10_000);
    return () => window.clearInterval(t);
  }, [phase]);

  const submit = useCallback(() => {
    const text = input.trim();
    if (!text || phase === "error") return;
    setInput("");
    setOutbox((prev) => [...prev, { text }]);
  }, [input, phase]);

  const stopTurn = useCallback(() => {
    void cancelArchitect(sessionId);
    setStalled(false);
    // A cancelled stream ends on its own; "busy" clears via its retry timer.
  }, [sessionId]);

  const doApply = useCallback(async () => {
    if (!review) return;
    const msg = messages[review.mi];
    if (!msg || msg.role !== "assistant") return;
    const block = msg.blocks[review.bi];
    if (!block || block.kind !== "plan" || !block.plan) return;
    setApplyBusy(true);
    setApplyError(null);
    const paths = block.plan.operations.map((o) => o.path);
    const outcome = await applyPlan(block.plan, sessionId);
    setApplyBusy(false);
    if (outcome.graph) {
      setMessages((prev) => {
        const next = [...prev];
        const m = next[review.mi];
        if (m && m.role === "assistant") {
          const blocks = [...m.blocks];
          blocks[review.bi] = {
            ...block,
            state: "applied",
            txId: outcome.txId,
            plan: undefined,
          };
          next[review.mi] = { role: "assistant", blocks };
        }
        return next;
      });
      setReview(null);
      onApplied?.(paths);
    } else {
      setApplyError(
        outcome.error?.message ?? "Apply failed — nothing was written.",
      );
    }
  }, [review, messages, sessionId, onApplied]);

  /* Instant undo for an applied card (R3). Safe server-side: if anything
     touched those files since, the revert refuses (stale_rollback) and we say
     so — git history is the recovery path then. */
  const doRevert = useCallback(
    async (mi: number, bi: number) => {
      const msg = messages[mi];
      if (!msg || msg.role !== "assistant") return;
      const block = msg.blocks[bi];
      if (!block || block.kind !== "plan" || !block.txId) return;
      const outcome = await revertTx(block.txId, sessionId);
      setMessages((prev) => {
        const next = [...prev];
        const m = next[mi];
        if (!m || m.role !== "assistant") return prev;
        const blocks = [...m.blocks];
        if (outcome.graph) {
          blocks[bi] = { ...block, state: "reverted" };
        } else {
          blocks.push({
            kind: "text",
            text: `⚠ Revert refused: ${outcome.error?.message ?? "unknown error"}`,
          });
        }
        next[mi] = { role: "assistant", blocks };
        return next;
      });
      if (outcome.graph) onApplied?.([]);
    },
    [messages, sessionId, onApplied],
  );

  if (!visible) return null;

  const reviewBlock =
    review && messages[review.mi]?.role === "assistant"
      ? (messages[review.mi] as { blocks: Block[] }).blocks[review.bi]
      : null;
  const composerDisabled = phase === "error";

  return (
    <div style={s.wrap}>
      <div style={s.header}>
        <span style={s.title}>Architect</span>
        <span style={s.subtitle}>Proposes changes you review and apply</span>
      </div>

      <div style={s.transcript} ref={scrollRef}>
        {messages.length === 0 && outbox.length === 0 && phase !== "error" && (
          <div style={s.empty}>
            {phase === "starting" ? (
              "Starting the architect…"
            ) : (
              <>
                Ask the architect to shape your blueprint — “add a code-review
                skill”, “connect the files tool to the primary agent”, “what’s
                broken?”. It proposes changes; you review and apply them.
              </>
            )}
          </div>
        )}

        {phase === "error" && (
          <div style={s.startError}>
            {startError}
            <button
              style={s.retry}
              onClick={() => {
                startedRef.current = true;
                void begin();
              }}
            >
              Try again
            </button>
          </div>
        )}

        {restoredCount > 0 && (
          <div style={s.divider}>
            Restored from your last session — earlier drafts have expired; the
            architect starts fresh.
          </div>
        )}

        {messages.map((m, mi) =>
          m.role === "user" ? (
            <div key={mi} style={s.userRow}>
              <div style={s.userBubble}>{m.text}</div>
            </div>
          ) : (
            <div key={mi} style={s.assistantRow}>
              {m.blocks.map((b, bi) => {
                if (b.kind === "think")
                  return showSteps ? (
                    <div key={bi} style={s.thinkText}>
                      {b.text}
                    </div>
                  ) : null;
                if (b.kind === "text")
                  return (
                    <div key={bi} style={s.text}>
                      {b.text}
                    </div>
                  );
                if (b.kind === "tool")
                  return (
                    <div key={bi} style={s.tool}>
                      <span style={s.toolDot} /> {b.label}
                    </div>
                  );
                return (
                  <div key={bi} style={s.planCard}>
                    <div style={s.planHead}>
                      <span style={s.planEyebrow}>Proposed change</span>
                      <span style={s.planSummary}>{b.summary}</span>
                    </div>
                    <div style={s.planMeta}>
                      {b.files} file{b.files === 1 ? "" : "s"}
                      {(b.updated ?? 0) > 0 && ` · ${b.updated} updated`}
                      {(b.removed ?? 0) > 0 && ` · ${b.removed} removed`}
                      {(b.edges ?? 0) > 0 && ` · ${b.edges} edge`}
                    </div>
                    {b.state === "applied" ? (
                      <span style={s.applied}>
                        ✓ Applied
                        {/* S9 activation is next-session: say so here, so
                            "is the workspace ingesting it?" never recurs. */}
                        {" · active in new terminals"}
                        {onRestartAgents && (
                          <button
                            style={s.restartBtn}
                            onClick={onRestartAgents}
                          >
                            Restart agent now
                          </button>
                        )}
                        {b.txId && (
                          <button
                            style={s.revertBtn}
                            title="Undo this change (refused if the files moved on since)"
                            onClick={() => void doRevert(mi, bi)}
                          >
                            Revert
                          </button>
                        )}
                      </span>
                    ) : b.state === "reverted" ? (
                      <span style={s.expired}>↺ Reverted.</span>
                    ) : b.state === "expired" ? (
                      <span style={s.expired}>
                        Drafted in an earlier session — ask again to redraft.
                      </span>
                    ) : (
                      <button
                        style={s.reviewBtn}
                        onClick={() => setReview({ mi, bi })}
                      >
                        Review &amp; apply
                      </button>
                    )}
                  </div>
                );
              })}
              {phase === "streaming" && mi === messages.length - 1 && (
                <button
                  style={s.architecting}
                  onClick={() => setShowSteps((v) => !v)}
                  title="Show the architect's live steps — reasoning and tool activity"
                >
                  <span style={s.pulse} />
                  Architecting…
                  <span style={s.stepsHint}>
                    {showSteps ? "hide steps" : "show steps"}
                  </span>
                </button>
              )}
            </div>
          ),
        )}

        {outbox.map((entry, i) => (
          <div key={`q-${i}`} style={s.userRow}>
            <div style={s.queuedBubble}>
              {entry.text}
              <span style={s.queuedTag}>queued</span>
            </div>
          </div>
        ))}
      </div>

      {(phase === "busy" || stalled) && (
        <div style={s.statusStrip}>
          <span>
            {phase === "busy"
              ? "The architect is finishing an earlier turn — your message is queued."
              : "Still working — nothing received for a while."}
          </span>
          <button style={s.stopBtn} onClick={stopTurn}>
            Stop that turn
          </button>
        </div>
      )}

      <div style={s.composer}>
        <textarea
          style={s.textarea}
          placeholder={
            phase === "starting"
              ? "Starting… (your message will queue)"
              : "Ask the architect…"
          }
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          disabled={composerDisabled}
          rows={2}
        />
        <button
          style={{
            ...s.sendBtn,
            ...(phase === "streaming" ? s.sendBusy : null),
          }}
          onClick={submit}
          disabled={!input.trim() || composerDisabled}
        >
          {phase === "streaming" || phase === "busy" ? "Queue" : "Send"}
        </button>
      </div>

      {review && reviewBlock?.kind === "plan" && reviewBlock.plan && (
        <PlanPreview
          plan={reviewBlock.plan}
          busy={applyBusy}
          error={applyError}
          onApply={doApply}
          onCancel={() => {
            setReview(null);
            setApplyError(null);
          }}
          currentContents={reviewContents}
        />
      )}
    </div>
  );
}

const s: Record<string, CSSProperties> = {
  wrap: {
    flex: 1,
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
    position: "relative",
    background: "var(--paper)",
  },
  header: {
    display: "flex",
    alignItems: "baseline",
    gap: "0.6rem",
    padding: "0.5rem 0.85rem",
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
  subtitle: { fontSize: "0.72rem", color: "var(--ink-muted)" },
  transcript: {
    flex: 1,
    minHeight: 0,
    overflowY: "auto",
    padding: "1rem 0.85rem",
    display: "flex",
    flexDirection: "column",
    gap: "0.85rem",
  },
  empty: {
    margin: "auto",
    maxWidth: "34ch",
    textAlign: "center",
    color: "var(--ink-muted)",
    fontSize: "0.85rem",
    lineHeight: 1.6,
  },
  startError: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "0.6rem",
    margin: "auto",
    color: "var(--ink)",
    fontSize: "0.85rem",
  },
  retry: {
    background: "var(--ink)",
    color: "var(--paper)",
    border: "none",
    borderRadius: "var(--radius-pill)",
    fontSize: "0.8rem",
    padding: "0.3rem 1rem",
    cursor: "pointer",
  },
  divider: {
    textAlign: "center",
    fontSize: "0.7rem",
    color: "var(--ink-muted)",
    borderBottom: "1px dashed var(--rule-strong)",
    paddingBottom: "0.6rem",
  },
  userRow: { display: "flex", justifyContent: "flex-end" },
  userBubble: {
    maxWidth: "80%",
    background: "var(--ink)",
    color: "var(--paper)",
    borderRadius: "var(--radius-lg)",
    padding: "0.45rem 0.75rem",
    fontSize: "0.86rem",
    lineHeight: 1.5,
    whiteSpace: "pre-wrap",
  },
  queuedBubble: {
    maxWidth: "80%",
    background: "var(--paper-sunken)",
    color: "var(--ink-soft)",
    border: "1px dashed var(--rule-strong)",
    borderRadius: "var(--radius-lg)",
    padding: "0.45rem 0.75rem",
    fontSize: "0.86rem",
    lineHeight: 1.5,
    whiteSpace: "pre-wrap",
    display: "flex",
    alignItems: "baseline",
    gap: "0.5rem",
  },
  queuedTag: {
    fontFamily: "var(--font-mono)",
    fontSize: "0.58rem",
    letterSpacing: "0.1em",
    textTransform: "uppercase",
    color: "var(--ink-muted)",
    whiteSpace: "nowrap",
  },
  assistantRow: { display: "flex", flexDirection: "column", gap: "0.5rem" },
  architecting: {
    alignSelf: "flex-start",
    display: "inline-flex",
    alignItems: "center",
    gap: "0.45rem",
    font: "inherit",
    fontSize: "0.82rem",
    fontStyle: "italic",
    color: "var(--ink-muted)",
    background: "none",
    border: "none",
    padding: 0,
    cursor: "pointer",
  },
  pulse: {
    width: "7px",
    height: "7px",
    borderRadius: "50%",
    background: "var(--ink)",
    display: "inline-block",
    animation: "spin 1.2s linear infinite",
  },
  stepsHint: {
    fontStyle: "normal",
    fontFamily: "var(--font-mono)",
    fontSize: "0.62rem",
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    textDecoration: "underline",
    textUnderlineOffset: "2px",
  },
  thinkText: {
    fontSize: "0.78rem",
    lineHeight: 1.55,
    color: "var(--ink-muted)",
    whiteSpace: "pre-wrap",
    borderLeft: "2px solid var(--rule-strong)",
    paddingLeft: "0.6rem",
  },
  text: {
    fontSize: "0.88rem",
    lineHeight: 1.6,
    color: "var(--ink)",
    whiteSpace: "pre-wrap",
  },
  tool: {
    display: "flex",
    alignItems: "center",
    gap: "0.4rem",
    fontSize: "0.78rem",
    color: "var(--ink-muted)",
    fontFamily: "var(--font-mono)",
  },
  toolDot: {
    width: "5px",
    height: "5px",
    borderRadius: "50%",
    background: "var(--ink-muted)",
    display: "inline-block",
  },
  planCard: {
    border: "1px solid var(--rule-strong)",
    borderRadius: "var(--radius-md)",
    padding: "0.7rem 0.8rem",
    display: "flex",
    flexDirection: "column",
    gap: "0.35rem",
    background: "var(--paper-sunken)",
  },
  planHead: { display: "flex", flexDirection: "column", gap: "0.15rem" },
  planEyebrow: {
    fontFamily: "var(--font-mono)",
    fontSize: "0.58rem",
    letterSpacing: "0.12em",
    textTransform: "uppercase",
    color: "var(--ink-muted)",
  },
  planSummary: { fontSize: "0.9rem", fontWeight: 600, color: "var(--ink)" },
  planMeta: {
    fontSize: "0.74rem",
    color: "var(--ink-muted)",
    fontFamily: "var(--font-mono)",
  },
  reviewBtn: {
    alignSelf: "flex-start",
    marginTop: "0.2rem",
    background: "var(--ink)",
    color: "var(--paper)",
    border: "none",
    borderRadius: "var(--radius-pill)",
    fontSize: "0.78rem",
    fontWeight: 600,
    padding: "0.3rem 0.9rem",
    cursor: "pointer",
  },
  applied: {
    alignSelf: "flex-start",
    marginTop: "0.2rem",
    fontSize: "0.78rem",
    fontWeight: 600,
    color: "var(--ink-soft)",
    display: "inline-flex",
    alignItems: "center",
    gap: "0.5rem",
    flexWrap: "wrap",
  },
  expired: {
    alignSelf: "flex-start",
    marginTop: "0.2rem",
    fontSize: "0.76rem",
    fontStyle: "italic",
    color: "var(--ink-muted)",
  },
  restartBtn: {
    font: "inherit",
    fontSize: "0.72rem",
    fontWeight: 600,
    color: "var(--paper)",
    background: "var(--ink)",
    border: "none",
    borderRadius: "var(--radius-pill)",
    padding: "0.15rem 0.7rem",
    cursor: "pointer",
  },
  revertBtn: {
    font: "inherit",
    fontSize: "0.72rem",
    fontWeight: 600,
    color: "var(--ink)",
    background: "none",
    border: "1px solid var(--rule-strong)",
    borderRadius: "var(--radius-pill)",
    padding: "0.15rem 0.7rem",
    cursor: "pointer",
  },
  statusStrip: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "0.6rem",
    padding: "0.4rem 0.85rem",
    borderTop: "1px solid var(--rule)",
    background: "var(--paper-sunken)",
    fontSize: "0.75rem",
    color: "var(--ink-soft)",
  },
  stopBtn: {
    font: "inherit",
    fontSize: "0.72rem",
    fontWeight: 600,
    color: "var(--ink)",
    background: "none",
    border: "1px solid var(--ink)",
    borderRadius: "var(--radius-pill)",
    padding: "0.15rem 0.7rem",
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  composer: {
    display: "flex",
    gap: "0.5rem",
    alignItems: "flex-end",
    padding: "0.6rem 0.85rem",
    borderTop: "1px solid var(--rule)",
  },
  textarea: {
    flex: 1,
    resize: "none",
    font: "inherit",
    fontSize: "0.86rem",
    lineHeight: 1.5,
    color: "var(--ink)",
    background: "var(--paper)",
    border: "1px solid var(--rule-strong)",
    borderRadius: "var(--radius-md)",
    padding: "0.4rem 0.6rem",
  },
  sendBtn: {
    background: "var(--ink)",
    color: "var(--paper)",
    border: "none",
    borderRadius: "var(--radius-pill)",
    fontSize: "0.82rem",
    fontWeight: 600,
    padding: "0.45rem 1.1rem",
    cursor: "pointer",
  },
  sendBusy: { opacity: 0.6, cursor: "default" },
};
