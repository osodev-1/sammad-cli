"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import {
  cancelCoder,
  ensureConversation,
  fetchCoderTurn,
  followCoder,
  respondCoder,
  sendCoder,
  textFromEvent,
  thinkFromEvent,
  toolLabel,
} from "@/lib/coder/client";
import {
  fromStored,
  reduce,
  toStored,
  type CoderBlock,
  type CoderMessage,
} from "@/lib/coder/transcript";
import type { CoderItem, RespondPayload } from "@/lib/coder/types";
import type { StoredCoderMessage } from "@/lib/sessions/state";
import { ApprovalCard, QuestionCard } from "./RequestCards";

type RequestBlock = Extract<CoderBlock, { kind: "request" }>;

const BUSY_RETRY_MS = 4000;
const STALL_AFTER_MS = 90_000;

/**
 * The Coder chat (P1b Task 6). Streams turns from the machine-hosted coding
 * agent (Claude Code) through a journaled conversation; approvals and
 * clarifying questions render as inline cards the user answers without
 * leaving the transcript.
 *
 * Adapted from ArchitectPanel's resilience machinery: the composer never
 * locks (messages queue and drain when the agent frees up), a watchdog
 * surfaces Stop on a quiet turn, and a dropped connection re-attaches to the
 * server-journaled turn from the last seen seq. The key difference from the
 * architect is the conversation itself: coder turns live behind an explicit
 * `conversationId` that can be dropped server-side (not_started/turn_failed),
 * in which case `begin()` re-mints a ticket and re-opens (or re-creates) the
 * conversation before the failed turn is resent.
 */
export default function CoderPanel({
  sessionId,
  visible,
  conversationId,
  onConversationId,
  initial,
  onPersist,
}: {
  sessionId?: string;
  visible: boolean;
  /** Persisted conversation id (from the PRD session's uiState); undefined
   * until the first successful ensure. */
  conversationId?: string;
  /** Called once a conversation id is known, to persist it upward. */
  onConversationId?: (cid: string) => void;
  /** Persisted transcript to restore (from the PRD session's uiState). */
  initial?: StoredCoderMessage[];
  /** Called (debounced, at turn boundaries) with the serialized transcript. */
  onPersist?: (messages: StoredCoderMessage[]) => void;
}) {
  const [phase, setPhase] = useState<
    "idle" | "starting" | "ready" | "streaming" | "busy" | "error"
  >("idle");
  const [startError, setStartError] = useState<string | null>(null);
  const [startErrorCode, setStartErrorCode] = useState<string | null>(null);
  const [cid, setCid] = useState<string | undefined>(conversationId);
  const [messages, setMessages] = useState<CoderMessage[]>(() =>
    fromStored(initial ?? []),
  );
  const [restoredCount, setRestoredCount] = useState(
    () => initial?.length ?? 0,
  );
  const [input, setInput] = useState("");
  const [outbox, setOutbox] = useState<
    { text: string; retry?: boolean; sendId?: string }[]
  >([]);
  /* R6-style resilience: reconnecting = the turn lives server-side, our pipe
     doesn't; activity = the always-on "what is it doing" line. */
  const [reconnecting, setReconnecting] = useState(false);
  const [activity, setActivity] = useState<string | null>(null);
  /* Editing a queued message pauses the drain so a finishing turn can't send
     the old text out from under the edit. */
  const [editingQueued, setEditingQueued] = useState<{
    index: number;
    draft: string;
  } | null>(null);
  const [stalled, setStalled] = useState(false);
  /* Clicking the working indicator reveals live steps (reasoning + tools). */
  const [showSteps, setShowSteps] = useState(false);
  /* Per-requestId busy flag for the inline approval/question cards. */
  const [respondBusy, setRespondBusy] = useState<Record<string, boolean>>({});

  const anchorKey = `sanad-coder-turn:${sessionId ?? "default"}`;
  const startedRef = useRef(false);
  /* Synchronous read of the current conversation id for begin()/runTurn(),
     which must always target the LATEST id (a dropped conversation gets
     re-minted mid-flow, before this ref's mirroring state re-renders). */
  const cidRef = useRef<string | undefined>(conversationId);
  /* Lets begin() re-enter runTurn (resume a running turn) despite runTurn
     being defined after begin() in this component. */
  const runTurnRef = useRef<
    | ((
        text: string,
        isRetry: boolean,
        sendId?: string,
        resume?: { turnId: string; at?: number },
      ) => Promise<void>)
    | null
  >(null);
  const drainingRef = useRef(false);
  const lastItemAtRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  /* Latest-value ref for the persist-upward callback (AP's onStatusPhaseRef
     pattern in SessionWorkspace): begin() must NOT depend on this prop
     directly — an inline arrow from the parent would give begin() a new
     identity on every parent render, re-arming startedRef's retry gate and
     firing a fresh ensureConversation() each time while phase is "error". */
  const onConversationIdRef = useRef(onConversationId);
  onConversationIdRef.current = onConversationId;

  /* If the persisted transcript arrives after mount (hydration race), adopt
     it — but never over a conversation that already started. */
  useEffect(() => {
    if (initial && initial.length > 0 && messages.length === 0) {
      setMessages(fromStored(initial));
      setRestoredCount(initial.length);
    }
    // messages deliberately unwatched: adopt-late only fires from empty.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial]);

  /* Same hydration race for the persisted conversationId: SessionWorkspace's
     uiState fetch resolves AFTER this panel mounts, so the `conversationId`
     prop can arrive several renders late. Without this, begin() would run
     with cidRef still undefined, call ensureConversation(undefined), and
     mint a brand-new conversation every reload — silently orphaning the
     persisted one (and eventually piling up against the server's
     conversation_limit). Adopt it — but never over a conversation that's
     already started (cidRef held, or begin() already fired): once a turn is
     underway, the LATEST id lives in cidRef/state, not in this prop. */
  useEffect(() => {
    if (conversationId && !cidRef.current && !startedRef.current) {
      cidRef.current = conversationId;
      setCid(conversationId);
    }
  }, [conversationId]);

  /* Open (or create) the conversation, then catch the panel up on whatever
     the server already knows: a turn still running (resume it live) or
     requests still awaiting an answer (fold them in as an answerable
     message) — so a reload never shows a stale, silent chat. */
  const begin = useCallback(async () => {
    setPhase("starting");
    setStartError(null);
    setStartErrorCode(null);
    const res = await ensureConversation(cidRef.current, sessionId);
    if (!res.ok || !res.conversationId) {
      setPhase("error");
      setStartError(res.error ?? "Could not start the coding agent.");
      setStartErrorCode(res.errorCode ?? null);
      startedRef.current = false; // allow retry
      return;
    }
    const newCid = res.conversationId;
    cidRef.current = newCid;
    setCid(newCid);
    onConversationIdRef.current?.(newCid);

    const state = await fetchCoderTurn(newCid, sessionId);
    if (state?.turn?.status === "running") {
      await runTurnRef.current?.(
        state.turn.userInput || "(earlier request)",
        true,
        undefined,
        {
          turnId: state.turn.turnId,
          at: state.turn.startedAt ? state.turn.startedAt * 1000 : Date.now(),
        },
      );
      return;
    }
    if (state?.pendingRequests && state.pendingRequests.length > 0) {
      const blocks = state.pendingRequests.reduce<CoderBlock[]>(
        (acc, pr) =>
          reduce(acc, {
            kind: "request",
            requestType: pr.requestType,
            requestId: pr.requestId,
            turnId: pr.turnId,
            request: pr.request,
          }),
        [],
      );
      setMessages((m) => [...m, { role: "assistant", blocks, at: Date.now() }]);
    }
    setPhase("ready");
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

  /* One turn — SERVER-AUTHORITATIVE: the machine journals every item, so
     this function is only a follower.
     Self-healing paths:
     - "busy": requeue at the front and retry shortly.
     - "turn_failed"/"not_started": the conversation was dropped server-side
       — re-mint via begin() (which re-opens, or re-creates if the id is
       gone) and resend ONCE.
     - CONNECTION DROP mid-turn: the turn keeps running server-side; we
       re-attach from the last seen seq (request cards replay too) and keep
       trying for ~6 minutes. A full page reload resumes the same turn via
       begin()'s server-authoritative fetchCoderTurn (using the persisted
       conversationId), NOT via the sessionStorage anchor below — those
       writes are currently vestigial (nothing reads the anchor back),
       ledgered for a P2 cleanup rather than removed here. */
  const runTurn = useCallback(
    async (
      text: string,
      isRetry: boolean,
      sendId?: string,
      resume?: { turnId: string; at?: number },
    ) => {
      setPhase("streaming");
      setStalled(false);
      setActivity(null);
      lastItemAtRef.current = Date.now();
      const at = resume?.at ?? Date.now();
      setMessages((m) => [
        ...m,
        { role: "user", text, at },
        { role: "assistant", blocks: [], at },
      ]);
      const activeCid = cidRef.current;
      const flags = { busy: false, failed: false, ended: false };
      let turnId: string | null = resume?.turnId ?? null;
      let lastSeq = -1;
      const saveAnchor = () => {
        try {
          window.sessionStorage.setItem(
            anchorKey,
            JSON.stringify({ turnId, lastSeq, userText: text, at }),
          );
        } catch {
          /* storage blocked */
        }
      };
      const consume = (item: CoderItem) => {
        lastItemAtRef.current = Date.now();
        setStalled(false);
        if (typeof item.seq === "number") {
          if (item.seq <= lastSeq) return; // duplicate from a re-follow
          lastSeq = item.seq;
          saveAnchor();
        }
        if (item.kind === "turn") {
          turnId = item.turnId;
          saveAnchor();
          return;
        }
        if (item.kind === "end") {
          flags.ended = true;
          return;
        }
        if (item.kind === "error" && item.code === "network") {
          return; // this leg dropped — the outer loop re-attaches
        }
        if (item.kind === "error" && item.code === "busy") {
          flags.busy = true;
          flags.ended = true;
          return;
        }
        if (
          item.kind === "error" &&
          (item.code === "turn_failed" || item.code === "not_started")
        ) {
          flags.failed = true;
          flags.ended = true;
          // First attempt heals silently (re-open + resend); on the retry
          // the error falls through to render, so a real outage stays
          // visible.
          if (!isRetry) return;
        }
        // The always-on activity line — the user must SEE work happening.
        const think = thinkFromEvent(item);
        const label = toolLabel(item);
        if (think) setActivity("Thinking");
        else if (label) setActivity(label);
        else if (textFromEvent(item)) setActivity("Writing");
        setMessages((prev) => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (last && last.role === "assistant") {
            next[next.length - 1] = {
              role: "assistant",
              at: last.at,
              blocks: reduce(last.blocks, item),
            };
          }
          return next;
        });
      };

      if (!activeCid) {
        // Nothing to talk to (shouldn't happen — phase only reaches "ready"
        // once begin() has a cid). Surface it like a dropped conversation so
        // begin() gets a chance to re-open before we give up on the text.
        flags.failed = true;
        flags.ended = true;
      } else if (resume) {
        await followCoder(activeCid, resume.turnId, 0, sessionId, consume);
      } else {
        await sendCoder(activeCid, text, sendId, sessionId, consume);
      }
      // Re-attach while the turn lives but our connection didn't.
      let attempts = 0;
      while (!flags.ended && turnId && activeCid && attempts < 90) {
        setReconnecting(true);
        attempts += 1;
        await new Promise((r) => window.setTimeout(r, 4000));
        await followCoder(activeCid, turnId, lastSeq + 1, sessionId, consume);
      }
      setReconnecting(false);
      setActivity(null);
      try {
        window.sessionStorage.removeItem(anchorKey);
      } catch {
        /* storage blocked */
      }
      if (!flags.ended && turnId) {
        // Gave up re-attaching. The turn may still finish server-side — say
        // so honestly instead of pretending it failed.
        setMessages((prev) => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (last && last.role === "assistant") {
            next[next.length - 1] = {
              role: "assistant",
              at: last.at,
              blocks: [
                ...last.blocks,
                {
                  kind: "text",
                  text: "⚠ Lost contact with the workspace. The coding agent may still finish this turn.",
                },
              ],
            };
          }
          return next;
        });
        setPhase("ready");
        return;
      }
      if (flags.busy) {
        // Roll back the optimistic bubbles; the text waits in the queue.
        setMessages((prev) => prev.slice(0, -2));
        setOutbox((prev) => [{ text, retry: isRetry, sendId }, ...prev]);
        if (!resume && activeCid) {
          // Attach to the RUNNING turn and render it live — the bottom of
          // the chat shows the CURRENT state, with Stop on the active
          // message. When that turn ends (or is stopped), the queue drains
          // naturally.
          const state = await fetchCoderTurn(activeCid, sessionId);
          if (state?.turn?.status === "running") {
            await runTurnRef.current?.(
              state.turn.userInput || "(earlier request)",
              true,
              undefined,
              {
                turnId: state.turn.turnId,
                at: state.turn.startedAt
                  ? state.turn.startedAt * 1000
                  : Date.now(),
              },
            );
            return;
          }
        }
        setPhase("busy");
      } else if (flags.failed && !isRetry) {
        setMessages((prev) => prev.slice(0, -2));
        setOutbox((prev) => [{ text, retry: true, sendId }, ...prev]);
        await begin(); // re-mints a ticket, re-opens (or re-creates) the conversation
      } else {
        // A turn that ended with NOTHING (no content, no error item) must
        // never leave a blank message: explain, and invite a retry.
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
                  text: "⚠ No response arrived for this turn. Try again in a moment.",
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
    [sessionId, begin, anchorKey],
  );
  runTurnRef.current = runTurn;

  /* Drain the queue whenever the coder is free (paused mid-edit). */
  useEffect(() => {
    if (
      phase !== "ready" ||
      outbox.length === 0 ||
      drainingRef.current ||
      editingQueued !== null
    ) {
      return;
    }
    drainingRef.current = true;
    const [next, ...rest] = outbox;
    setOutbox(rest);
    void runTurn(next.text, next.retry ?? false, next.sendId).finally(() => {
      drainingRef.current = false;
    });
  }, [phase, outbox, runTurn, editingQueued]);

  /* Commit/cancel/remove for queued messages. An edit that empties the text
     removes the message; edited text drops any retry marker (it's new). */
  const commitQueuedEdit = useCallback(() => {
    if (!editingQueued) return;
    const text = editingQueued.draft.trim();
    setOutbox((prev) =>
      text
        ? prev.map((e, i) =>
            i === editingQueued.index
              ? { text, sendId: crypto.randomUUID() }
              : e,
          )
        : prev.filter((_, i) => i !== editingQueued.index),
    );
    setEditingQueued(null);
  }, [editingQueued]);

  const removeQueued = useCallback((index: number) => {
    setOutbox((prev) => prev.filter((_, i) => i !== index));
    setEditingQueued((cur) =>
      cur && cur.index === index
        ? null
        : cur && cur.index > index
          ? { ...cur, index: cur.index - 1 }
          : cur,
    );
  }, []);

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
    setOutbox((prev) => [...prev, { text, sendId: crypto.randomUUID() }]);
  }, [input, phase]);

  const stopTurn = useCallback(() => {
    if (!cid) return;
    void cancelCoder(cid, sessionId);
    setStalled(false);
    // A cancelled stream ends on its own; "busy" clears via its retry timer.
  }, [cid, sessionId]);

  /* Resolve a pending approval/question request. Only skip the local fold
     when the answered card is the LIVE TAIL of an actively streaming turn —
     that's the one case where the journal is guaranteed to deliver its own
     `request_resolved` moments later, and folding here too would just race
     it. Every other case (not streaming, OR streaming but the card sits in
     an earlier message — e.g. its turn's follower gave up or a busy-retry
     replayed the request into a new message pair, leaving the old copy
     behind) has no live follower for that card, so we fold optimistically:
     otherwise it would stay pending+interactive after a successful 200, and
     a second click would surface `request_gone` on an already-answered
     request. The "is it the tail" check reads `prev.length` inside the
     updater (not the outer `messages` closure) so it reflects the state at
     the moment this update actually applies, not at call time. */
  const respond = useCallback(
    async (mi: number, block: RequestBlock, payload: RespondPayload) => {
      if (!cid) return;
      const { requestId, requestType } = block;
      setRespondBusy((prev) => ({ ...prev, [requestId]: true }));
      const result = await respondCoder(cid, requestId, payload, sessionId);
      if (result.ok) {
        setMessages((prev) => {
          const isLiveTail = phase === "streaming" && mi === prev.length - 1;
          if (isLiveTail) return prev;
          const next = [...prev];
          const m = next[mi];
          if (m && m.role === "assistant") {
            next[mi] = {
              role: "assistant",
              at: m.at,
              blocks: reduce(m.blocks, {
                kind: "request_resolved",
                requestId,
                requestType,
                resolution: payload as unknown as Record<string, unknown>,
              }),
            };
          }
          return next;
        });
      } else if (result.code === "request_gone") {
        setMessages((prev) => {
          const next = [...prev];
          const m = next[mi];
          if (m && m.role === "assistant") {
            next[mi] = {
              role: "assistant",
              at: m.at,
              blocks: reduce(m.blocks, {
                kind: "request_cancelled",
                requestId,
              }),
            };
          }
          return next;
        });
      } else {
        setMessages((prev) => {
          const next = [...prev];
          const m = next[mi];
          if (m && m.role === "assistant") {
            next[mi] = {
              role: "assistant",
              at: m.at,
              blocks: [
                ...m.blocks,
                {
                  kind: "text",
                  text: `⚠ ${result.message ?? "Could not send your response."}`,
                },
              ],
            };
          }
          return next;
        });
      }
      setRespondBusy((prev) => {
        const next = { ...prev };
        delete next[requestId];
        return next;
      });
    },
    [cid, sessionId, phase],
  );

  if (!visible) return null;

  // Scoped to the LAST message only: consume() folds exclusively into
  // messages[length-1], so an earlier message's request block can never be
  // reached by a later request_cancelled/request_resolved fold (its turn's
  // follower may have given up, or a busy-retry replayed the request into a
  // NEW message pair, stranding the old copy pending forever). Scanning the
  // whole transcript would let that stranded card hijack the status strip
  // permanently, masking the activity label and the stall watchdog on every
  // later turn.
  const lastMessage = messages[messages.length - 1];
  const hasPendingRequest =
    !!lastMessage &&
    lastMessage.role === "assistant" &&
    lastMessage.blocks.some((b) => b.kind === "request" && b.state === "pending");
  const composerDisabled = phase === "error";

  return (
    <div style={s.wrap}>
      <div style={s.header}>
        <span style={s.title}>Coder</span>
        <span style={s.subtitle}>Works directly in your workspace</span>
      </div>

      <div style={s.transcript} ref={scrollRef}>
        {messages.length === 0 && outbox.length === 0 && phase !== "error" && (
          <div style={s.empty}>
            {phase === "starting" ? (
              "Starting the coding agent…"
            ) : (
              <>
                Ask the coding agent to make a change — "add a health check
                endpoint", "fix the failing test", "refactor this module". It
                works directly in your workspace and asks before anything
                risky.
              </>
            )}
          </div>
        )}

        {phase === "error" && (
          <div style={s.startError}>
            {startErrorCode === "coder_not_enabled"
              ? "The coding agent isn't enabled for this account."
              : startError}
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
            Restored from your last session — earlier drafts have expired;
            the coding agent starts fresh.
          </div>
        )}

        {messages.map((m, mi) => {
          const day = m.at ? new Date(m.at).toDateString() : null;
          const prevAt = mi > 0 ? messages[mi - 1].at : undefined;
          const prevDay = prevAt ? new Date(prevAt).toDateString() : null;
          const sep =
            day && day !== prevDay ? (
              <div style={s.dateSep}>
                {new Date(m.at!).toLocaleDateString([], {
                  weekday: "short",
                  month: "short",
                  day: "numeric",
                })}
              </div>
            ) : null;
          return (
            <Fragment key={mi}>
              {sep}
              {m.role === "user" ? (
                <div style={s.userRow}>
                  {m.at && (
                    <span style={s.msgTime}>
                      {new Date(m.at).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  )}
                  <div style={s.userBubble}>{m.text}</div>
                </div>
              ) : (
                <div key={mi} style={s.assistantRow}>
                  {m.at && (
                    <span style={s.msgTimeLeft}>
                      {new Date(m.at).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  )}
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
                    return b.requestType === "approval" ? (
                      <ApprovalCard
                        key={bi}
                        block={b}
                        busy={!!respondBusy[b.requestId]}
                        onRespond={(payload) => void respond(mi, b, payload)}
                      />
                    ) : (
                      <QuestionCard
                        key={bi}
                        block={b}
                        busy={!!respondBusy[b.requestId]}
                        onRespond={(payload) => void respond(mi, b, payload)}
                      />
                    );
                  })}
                  {phase === "streaming" && mi === messages.length - 1 && (
                    <button
                      style={s.working}
                      onClick={() => setShowSteps((v) => !v)}
                      title="Show the coding agent's live steps — reasoning and tool activity"
                    >
                      <span style={s.pulse} />
                      Coding…
                      <span style={s.stepsHint}>
                        {showSteps ? "hide steps" : "show steps"}
                      </span>
                    </button>
                  )}
                </div>
              )}
            </Fragment>
          );
        })}

        {outbox.map((entry, i) => (
          <div key={`q-${i}`} style={s.userRow}>
            {editingQueued?.index === i ? (
              <textarea
                autoFocus
                style={s.queuedEdit}
                value={editingQueued.draft}
                rows={2}
                onChange={(e) =>
                  setEditingQueued({ index: i, draft: e.target.value })
                }
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    commitQueuedEdit();
                  } else if (e.key === "Escape") {
                    setEditingQueued(null);
                  }
                }}
                onBlur={commitQueuedEdit}
              />
            ) : (
              <div style={s.queuedBubble}>
                {entry.text}
                <span style={s.queuedTag}>queued</span>
                <span style={s.queuedActions}>
                  <button
                    type="button"
                    style={s.queuedAction}
                    title="Edit before it sends"
                    aria-label="Edit queued message"
                    onClick={() =>
                      setEditingQueued({ index: i, draft: entry.text })
                    }
                  >
                    ✎
                  </button>
                  <button
                    type="button"
                    style={s.queuedAction}
                    title="Remove from the queue"
                    aria-label="Remove queued message"
                    onClick={() => removeQueued(i)}
                  >
                    ✕
                  </button>
                </span>
              </div>
            )}
          </div>
        ))}
      </div>

      {(phase === "starting" ||
        phase === "streaming" ||
        phase === "busy" ||
        reconnecting) && (
        <div style={s.statusStrip}>
          <span style={s.statusText}>
            <span style={s.statusPulse} />
            {reconnecting
              ? "Connection lost — the coding agent keeps working; reconnecting…"
              : phase === "busy"
                ? "The coding agent is finishing an earlier turn — your message is queued."
                : phase === "starting"
                  ? "Starting the coding agent…"
                  : hasPendingRequest
                    ? "Waiting on your approval…"
                    : stalled
                      ? "Still working — nothing received for a while."
                      : `${activity ?? "Working"}…`}
          </span>
          {(phase === "busy" || stalled) && (
            <button style={s.stopBtn} onClick={stopTurn}>
              Stop that turn
            </button>
          )}
        </div>
      )}

      <div style={s.composer}>
        <textarea
          style={s.textarea}
          placeholder={
            phase === "starting"
              ? "Starting… (your message will queue)"
              : "Ask the coder…"
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
  userRow: {
    display: "flex",
    justifyContent: "flex-end",
    alignItems: "flex-end",
    gap: "0.4rem",
  },
  dateSep: {
    textAlign: "center",
    fontFamily: "var(--font-mono)",
    fontSize: "0.62rem",
    letterSpacing: "0.1em",
    textTransform: "uppercase",
    color: "var(--ink-muted)",
    margin: "0.4rem 0 0.1rem",
  },
  msgTime: {
    fontFamily: "var(--font-mono)",
    fontSize: "0.6rem",
    color: "var(--ink-muted)",
    whiteSpace: "nowrap",
  },
  msgTimeLeft: {
    fontFamily: "var(--font-mono)",
    fontSize: "0.6rem",
    color: "var(--ink-muted)",
  },
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
  queuedEdit: {
    maxWidth: "80%",
    minWidth: "60%",
    resize: "none",
    font: "inherit",
    fontSize: "0.86rem",
    lineHeight: 1.5,
    color: "var(--ink)",
    background: "var(--paper)",
    border: "1px dashed var(--rule-strong)",
    borderRadius: "var(--radius-lg)",
    padding: "0.45rem 0.75rem",
  },
  queuedActions: {
    display: "inline-flex",
    gap: "0.1rem",
    marginLeft: "0.2rem",
  },
  queuedAction: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "20px",
    height: "20px",
    background: "none",
    border: "none",
    borderRadius: "var(--radius-sm)",
    color: "var(--ink-muted)",
    cursor: "pointer",
    fontSize: "0.72rem",
    padding: 0,
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
  working: {
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
  statusText: {
    display: "inline-flex",
    alignItems: "center",
    gap: "0.45rem",
    minWidth: 0,
  },
  statusPulse: {
    width: "7px",
    height: "7px",
    borderRadius: "50%",
    background: "var(--ink)",
    display: "inline-block",
    flexShrink: 0,
    animation: "spin 1.2s linear infinite",
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
