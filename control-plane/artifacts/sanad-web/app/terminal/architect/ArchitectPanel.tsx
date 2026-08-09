"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import {
  askArchitect,
  planFromEvent,
  startArchitect,
  textFromEvent,
  toolLabel,
  type ArchitectItem,
} from "@/lib/architect/client";
import { applyPlan, type ChangePlan } from "@/lib/blueprint/api";
import PlanPreview from "../graph/PlanPreview";

type Block =
  | { kind: "text"; text: string }
  | { kind: "tool"; label: string }
  | {
      kind: "plan";
      plan: ChangePlan;
      state: "pending" | "applied";
      txId?: string;
    };

type Message =
  { role: "user"; text: string } | { role: "assistant"; blocks: Block[] };

/* Fold one stream item into the in-progress assistant message's blocks. */
function reduce(blocks: Block[], item: ArchitectItem): Block[] {
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
  if (plan) return [...blocks, { kind: "plan", plan, state: "pending" }];
  if (item.kind === "error") {
    return [
      ...blocks,
      { kind: "text", text: `⚠ ${item.message ?? "Something went wrong."}` },
    ];
  }
  return blocks;
}

/**
 * The Architect chat (M3c). Streams one turn from the machine-hosted architect
 * agent and renders its proposals as review cards — Apply routes through the
 * same transaction endpoint as manual authoring (M2), never a new write path.
 */
export default function ArchitectPanel({
  sessionId,
  visible,
  onApplied,
  onRestartAgents,
}: {
  sessionId?: string;
  visible: boolean;
  /** Called after a plan is applied, with the paths it wrote (to reveal them). */
  onApplied?: (writtenPaths: string[]) => void;
  /** Kill + respawn the agent terminals so a new definition loads now (S9). */
  onRestartAgents?: () => void;
}) {
  const [phase, setPhase] = useState<
    "idle" | "starting" | "ready" | "streaming" | "error"
  >("idle");
  const [startError, setStartError] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [review, setReview] = useState<{ mi: number; bi: number } | null>(null);
  const [applyBusy, setApplyBusy] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);

  const startedRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);

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
  }, [messages]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || phase === "streaming" || phase === "starting") return;
    setInput("");
    setMessages((m) => [
      ...m,
      { role: "user", text },
      { role: "assistant", blocks: [] },
    ]);
    setPhase("streaming");
    await askArchitect(text, sessionId, (item) => {
      if (item.kind === "end") return;
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
    setPhase("ready");
  }, [input, phase, sessionId]);

  const doApply = useCallback(async () => {
    if (!review) return;
    const msg = messages[review.mi];
    if (!msg || msg.role !== "assistant") return;
    const block = msg.blocks[review.bi];
    if (!block || block.kind !== "plan") return;
    setApplyBusy(true);
    setApplyError(null);
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
          };
          next[review.mi] = { role: "assistant", blocks };
        }
        return next;
      });
      setReview(null);
      onApplied?.(block.plan.operations.map((o) => o.path));
    } else {
      setApplyError(
        outcome.error?.message ?? "Apply failed — nothing was written.",
      );
    }
  }, [review, messages, sessionId, onApplied]);

  if (!visible) return null;

  const reviewPlan =
    review &&
    messages[review.mi]?.role === "assistant" &&
    (messages[review.mi] as { blocks: Block[] }).blocks[review.bi];

  return (
    <div style={s.wrap}>
      <div style={s.header}>
        <span style={s.title}>Architect</span>
        <span style={s.subtitle}>Proposes changes you review and apply</span>
      </div>

      <div style={s.transcript} ref={scrollRef}>
        {messages.length === 0 && phase !== "error" && (
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

        {messages.map((m, mi) =>
          m.role === "user" ? (
            <div key={mi} style={s.userRow}>
              <div style={s.userBubble}>{m.text}</div>
            </div>
          ) : (
            <div key={mi} style={s.assistantRow}>
              {m.blocks.length === 0 &&
                phase === "streaming" &&
                mi === messages.length - 1 && (
                  <div style={s.thinking}>Thinking…</div>
                )}
              {m.blocks.map((b, bi) => {
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
                      <span style={s.planSummary}>{b.plan.summary}</span>
                    </div>
                    <div style={s.planMeta}>
                      {b.plan.operations.length} file
                      {b.plan.operations.length === 1 ? "" : "s"}
                      {(b.plan.graphDelta.nodesChanged?.length ?? 0) > 0 &&
                        ` · ${b.plan.graphDelta.nodesChanged!.length} updated`}
                      {b.plan.graphDelta.edgesAdded.length > 0 &&
                        ` · ${b.plan.graphDelta.edgesAdded.length} edge`}
                    </div>
                    {b.state === "applied" ? (
                      <span style={s.applied}>
                        ✓ Applied
                        {/* S9 activation is next-session: say so here, so
                            "is the workspace ingesting it?" never recurs. */}
                        {b.plan.operations.some((o) =>
                          o.path.endsWith("/SKILL.md"),
                        ) && (
                          <>
                            {" · active in new terminals"}
                            {onRestartAgents && (
                              <button
                                style={s.restartBtn}
                                onClick={onRestartAgents}
                              >
                                Restart agent now
                              </button>
                            )}
                          </>
                        )}
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
            </div>
          ),
        )}
      </div>

      <div style={s.composer}>
        <textarea
          style={s.textarea}
          placeholder={
            phase === "starting" ? "Starting…" : "Ask the architect…"
          }
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          disabled={phase === "starting" || phase === "error"}
          rows={2}
        />
        <button
          style={{
            ...s.sendBtn,
            ...(phase === "streaming" ? s.sendBusy : null),
          }}
          onClick={() => void send()}
          disabled={
            !input.trim() || phase === "streaming" || phase === "starting"
          }
        >
          {phase === "streaming" ? "…" : "Send"}
        </button>
      </div>

      {review && reviewPlan && reviewPlan.kind === "plan" && (
        <PlanPreview
          plan={reviewPlan.plan}
          busy={applyBusy}
          error={applyError}
          onApply={doApply}
          onCancel={() => {
            setReview(null);
            setApplyError(null);
          }}
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
  assistantRow: { display: "flex", flexDirection: "column", gap: "0.5rem" },
  thinking: {
    color: "var(--ink-muted)",
    fontSize: "0.82rem",
    fontStyle: "italic",
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
