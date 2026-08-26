"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import {
  cancelCoder,
  composerButtonsForPhase,
  dequeueCoder,
  ensureConversation,
  fetchCoderTurn,
  followCoder,
  modeFromEvent,
  needsInterruptedReplay,
  queueCoder,
  respondCoder,
  sendCoder,
  setCoderMode,
  steerCoder,
  textFromEvent,
  thinkFromEvent,
  toolLabel,
  type CoderPhase,
} from "@/lib/coder/client";
import {
  fromStored,
  reduce,
  reduceMessage,
  sameCheckpointItems,
  toStored,
  type CheckpointSummary,
  type CoderBlock,
  type CoderMessage,
} from "@/lib/coder/transcript";
import type { CoderItem, RespondPayload } from "@/lib/coder/types";
import { leaseStatusLabel, queueEntryLabel } from "@/lib/coder/queueLabels";
import type { StoredCoderMessage } from "@/lib/sessions/state";
import { button, disabled, size } from "../../ui/theme";
import { ApprovalCard, QuestionCard } from "./RequestCards";
import { ToolCard } from "./ToolCard";
import { PlanCard } from "./PlanCard";
import { CheckpointFooter } from "./CheckpointFooter";
import ConversationSwitcher from "./ConversationSwitcher";

type RequestBlock = Extract<CoderBlock, { kind: "request" }>;
type AssistantMessage = Extract<CoderMessage, { role: "assistant" }>;

/** The three P2a-supported permission modes — no yolo here (never surfaced
 * in this panel; see P2a's `apply_permission_mode`). */
type CoderMode = "plan" | "default" | "accept-edits";

const MODE_OPTIONS: { value: CoderMode; label: string }[] = [
  { value: "plan", label: "Plan" },
  { value: "default", label: "Default" },
  { value: "accept-edits", label: "Accept edits" },
];

/** One-line meaning of each mode, per P2a's `apply_permission_mode`: default
 * auto-approves `edit file`; accept-edits also auto-approves edits outside
 * the workspace; plan is read-only (proposes, never applies). Shell always
 * asks in every mode — there is no yolo tier here. */
const MODE_CAPTIONS: Record<CoderMode, string> = {
  default: "Edits auto-approved · shell asks",
  "accept-edits": "Edits auto-approved (incl. outside the workspace) · shell asks",
  plan: "Read-only — proposes a plan, makes no changes",
};

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
  lastInterruptedTurnId,
  onLastInterruptedTurnId,
  onCheckpoints,
  onReverted,
  onSwitchConversation,
  onCreateConversation,
  creatingConversation,
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
  /** Persisted turnId of the last "interrupted" (restart-recovery) turn
   * this panel already surfaced (from the PRD session's uiState). Compared
   * in begin() against the CURRENT interrupted turnId (P3 Task 4 Fix B) so
   * a reload — or a begin() re-entry, e.g. the busy self-heal path — never
   * replays the same interrupted turn twice. */
  lastInterruptedTurnId?: string;
  /** Called once an interrupted turn has been surfaced, to persist its
   * turnId upward (mirrors onConversationId). */
  onLastInterruptedTurnId?: (turnId: string) => void;
  /** Called (on every messages change) with this conversation's checkpoint-
   * bearing turns, oldest first — SessionWorkspace threads this into
   * ContextDock's Checkpoints section (P5 Task 4) so the dock can list/
   * Review/Revert them without a second fetch of its own. */
  onCheckpoints?: (items: { turnId: string; checkpoint: CheckpointSummary }[]) => void;
  /** Called after a successful revert (from THIS panel's own footers, or
   * from the dock's — either way the workspace tree just changed under
   * everything else that reads it). Revert never touches this panel's own
   * turn machine, so nothing here needs to react beyond bubbling the
   * "go refresh the file tree" signal upward. */
  onReverted?: () => void;
  /** Minimal conversation switcher (P6a Task 4) — called when the user
   * picks a DIFFERENT conversation from the header switcher. Owned by
   * SessionWorkspace: it's the one that resets the persisted transcript
   * and forces this panel to remount fresh for the new conversation (see
   * SessionWorkspace's `switchCoderConversation`/`coderEpoch`), so this
   * panel never has to reconcile one conversation's live state against
   * another's transcript mid-flight. */
  onSwitchConversation?: (conversationId: string) => void;
  /** "New conversation" action from the same switcher — SessionWorkspace
   * mints a ticket and creates one, then calls `onSwitchConversation` with
   * the result (or surfaces `conversation_limit`/other failures itself). */
  onCreateConversation?: () => void;
  /** True while `onCreateConversation`'s request is in flight — threaded
   * through so the switcher can disable itself against a double-click. */
  creatingConversation?: boolean;
}) {
  const [phase, setPhase] = useState<CoderPhase>("idle");
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
  /* The server-side follow-up queue (P4b), mirrored from `/turn`'s `queue` —
     THIS is the QueueStrip's source of truth; there is no client outbox
     anymore. Seeded/reconciled in begin(), after enqueue/dequeue, and on the
     periodic /turn poll below (and, incidentally, every time runTurn checks
     whether a follow-up turn already drained in). */
  const [queue, setQueue] = useState<
    { sendId: string; input: string; reason?: string; blockedBy?: string }[]
  >([]);
  /* Workspace write-lease reading (P6a Task 3's `/turn` "lease" field),
     synced alongside `queue` at every fetchCoderTurn() call site below —
     null until the first read lands, then whatever the server last
     reported. Rendered via `leaseStatusLabel` (lib/coder/queueLabels.ts),
     never read/rendered raw (see that helper's docstring on why). */
  const [lease, setLease] = useState<{
    kind: "conversation" | "revert" | null;
    holder: string | null;
    heldSeconds: number;
  } | null>(null);
  /* R6-style resilience: reconnecting = the turn lives server-side, our pipe
     doesn't; activity = the always-on "what is it doing" line. */
  const [reconnecting, setReconnecting] = useState(false);
  const [activity, setActivity] = useState<string | null>(null);
  /* Editing a queued message — keyed by `sendId`, NOT array index (P4
     final-review, Important A). `queue` is overwritten wholesale by
     settleAfterTurn() and the streaming poll below any time the server
     reconciles (another item auto-draining, an edit/removal from another
     tab, …) — an index captured when the edit began can point at a
     DIFFERENT item by the time the edit commits (queue=[A,B,C], edit B at
     index 1, A drains, queue becomes [B,C], index 1 now means C). Keying by
     sendId and re-deriving the index at commit time (see
     `commitQueuedEdit`) makes the lookup correct regardless of how many
     times `queue` was overwritten in between. Committing re-enqueues under
     a fresh sendId (dequeue old + queue new); it no longer pauses a local
     drain (there is none), it just optimistically edits the strip. */
  const [editingQueued, setEditingQueued] = useState<{
    sendId: string;
    draft: string;
  } | null>(null);
  /* Latest-value ref for the guard below — read (never depended on) by the
     streaming poll and settleAfterTurn() so neither one's periodic/turn-end
     `setQueue` overwrite fires while an edit is in flight (defense in depth
     alongside the sendId-keying above; mirrors the old client-outbox
     model's "pause the drain while editing" invariant). A `useEffect`
     dependency would restart the poll's interval on every keystroke, so
     this is a ref, not a dependency. */
  const editingQueuedRef = useRef<{ sendId: string; draft: string } | null>(
    null,
  );
  editingQueuedRef.current = editingQueued;
  const [stalled, setStalled] = useState(false);
  /* Clicking the working indicator reveals live steps (reasoning + tools). */
  const [showSteps, setShowSteps] = useState(false);
  /* Per-requestId busy flag for the inline approval/question cards. */
  const [respondBusy, setRespondBusy] = useState<Record<string, boolean>>({});
  /* Live permission mode — seeded from /turn in begin(), kept live via
     StatusUpdate events in consume(), and driven optimistically by the
     segmented control (reverted on a failed /mode call). */
  const [mode, setMode] = useState<CoderMode>("default");
  /* Brief inline error when a mode switch is rejected server-side — this
     panel has no toast affordance, so it borrows the same "⚠ text, then
     fade" idiom used elsewhere here, just scoped to the mode row instead of
     the transcript. */
  const [modeNotice, setModeNotice] = useState<string | null>(null);
  const modeNoticeTimerRef = useRef<number | null>(null);

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
  const lastItemAtRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  /* Latest-value ref for the persist-upward callback (AP's onStatusPhaseRef
     pattern in SessionWorkspace): begin() must NOT depend on this prop
     directly — an inline arrow from the parent would give begin() a new
     identity on every parent render, re-arming startedRef's retry gate and
     firing a fresh ensureConversation() each time while phase is "error". */
  const onConversationIdRef = useRef(onConversationId);
  onConversationIdRef.current = onConversationId;
  /* Same latest-value treatment for the interrupted-turn idempotency guard
   * (P3 Task 4 Fix B): begin() reads `lastInterruptedTurnIdRef.current` at
   * call time rather than closing over the prop, so a value this same
   * begin() call just persisted (via onLastInterruptedTurnIdRef, below) is
   * never stale — and, symmetrically with onConversationIdRef above, begin()
   * doesn't need this prop in its dependency array. */
  const lastInterruptedTurnIdRef = useRef(lastInterruptedTurnId);
  lastInterruptedTurnIdRef.current = lastInterruptedTurnId;
  const onLastInterruptedTurnIdRef = useRef(onLastInterruptedTurnId);
  onLastInterruptedTurnIdRef.current = onLastInterruptedTurnId;

  /* Same latest-value treatment (P5 Task 4) — derived from `messages` below,
   * not from any begin()/runTurn() control flow, but kept as a ref for the
   * same reason: an inline arrow from SessionWorkspace must not force this
   * effect to re-fire on every parent render. */
  const onCheckpointsRef = useRef(onCheckpoints);
  onCheckpointsRef.current = onCheckpoints;
  /* Last list actually EMITTED to `onCheckpoints` (P5 final-review fix,
   * paired with the `sameCheckpointItems` guard below) — not the same thing
   * as `messages`: this is what lets the effect tell "a checkpoint really
   * changed" apart from "some unrelated field on `messages` changed",
   * without which every streamed token would re-emit a freshly-built array
   * and defeat the parent's `useState` bail-out (see the effect's comment). */
  const lastCheckpointsRef = useRef<{ turnId: string; checkpoint: CheckpointSummary }[]>([]);

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
     message) — so a reload never shows a stale, silent chat. Returns which
     of the three outcomes happened — runTurn's turn_failed/not_started
     self-heal (P4 Task 4) uses this to decide whether it's safe to resend
     the ORIGINAL failed text, instead of the retired client outbox:
     "failed" (never opened — cidRef still invalid) or "resumed" (opened,
     AND already resumed some running turn found on it — resending on top
     would risk asking the same thing twice, since that running turn may
     well BE the original send landing server-side despite our client
     seeing turn_failed/not_started) both skip the resend; only "ready"
     (opened, genuinely idle) resends. */
  const begin = useCallback(async (): Promise<"failed" | "resumed" | "ready"> => {
    setPhase("starting");
    setStartError(null);
    setStartErrorCode(null);
    const res = await ensureConversation(cidRef.current, sessionId);
    if (!res.ok || !res.conversationId) {
      setPhase("error");
      setStartError(res.error ?? "Could not start the coding agent.");
      setStartErrorCode(res.errorCode ?? null);
      startedRef.current = false; // allow retry
      return "failed";
    }
    const newCid = res.conversationId;
    cidRef.current = newCid;
    setCid(newCid);
    onConversationIdRef.current?.(newCid);

    const state = await fetchCoderTurn(newCid, sessionId);
    if (
      state?.mode === "plan" ||
      state?.mode === "default" ||
      state?.mode === "accept-edits"
    ) {
      setMode(state.mode);
    }
    // Server queue (P4b) — seed the QueueStrip regardless of which turn
    // branch below fires; a queued follow-up can exist alongside a running,
    // interrupted, or idle turn alike.
    setQueue(state?.queue ?? []);
    setLease(state?.lease ?? null);
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
      return "resumed";
    }
    if (state?.turn?.status === "interrupted") {
      // Restart-recovery (P3 Task 2/3): the server reconciled a crash-mid-turn
      // to this TERMINAL status on reconstruction — the journal already ends
      // in a synthetic `end`, nothing is still running. This must NOT go
      // through runTurnRef's live resume above (that path sets phase
      // "streaming", arms the reconnect loop, and shows a Stop affordance —
      // all live-turn optics that would misrepresent an already-finished
      // turn). Instead, replay it ONCE — folding whatever pre-crash content
      // existed plus the reconstructed tail (a cancelled request card per
      // P1b's reducer, then the "interrupted by restart" ⚠ notice) into a
      // new message — so a reopened conversation never shows a stale,
      // silent chat or a pending approval that was actually dropped.
      const turnMeta = state.turn;
      if (!needsInterruptedReplay(turnMeta.turnId, lastInterruptedTurnIdRef.current)) {
        // Fix B (review finding): this exact turnId was already surfaced —
        // by THIS begin() call's own replay below (e.g. the busy self-heal
        // path re-entering begin() mid-turn), or by an earlier reload that
        // persisted `lastInterruptedTurnId` upward. Either way the restored
        // `initial` transcript already carries it; replaying again would
        // append a DUPLICATE turn. Stand pat.
        setPhase("ready");
        return "ready";
      }
      const at = turnMeta.startedAt ? turnMeta.startedAt * 1000 : Date.now();
      let msg: AssistantMessage = { role: "assistant", blocks: [], turnId: turnMeta.turnId };
      await followCoder(newCid, turnMeta.turnId, 0, sessionId, (item) => {
        msg = reduceMessage(msg, item);
      });
      setMessages((m) => [
        ...m,
        { role: "user", text: turnMeta.userInput || "(earlier request)", at },
        { ...msg, at },
      ]);
      lastInterruptedTurnIdRef.current = turnMeta.turnId;
      onLastInterruptedTurnIdRef.current?.(turnMeta.turnId);
      setPhase("ready");
      return "ready";
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
      // Pending requests are, in practice, always the SAME still-running
      // turn's (this system runs one turn at a time per conversation) — no
      // `checkpoint` yet either way (the turn hasn't finished), but the
      // turnId is cheap and already in scope.
      const turnId = state.pendingRequests[0]?.turnId;
      setMessages((m) => [
        ...m,
        { role: "assistant", blocks, at: Date.now(), ...(turnId ? { turnId } : {}) },
      ]);
    }
    setPhase("ready");
    return "ready";
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
  }, [messages, queue]);

  /* Persist at turn boundaries (never per streamed chunk). */
  useEffect(() => {
    if (!onPersist || phase === "streaming" || messages.length === 0) return;
    const t = window.setTimeout(() => onPersist(toStored(messages)), 600);
    return () => window.clearTimeout(t);
  }, [messages, phase, onPersist]);

  /* Report this conversation's checkpoint-bearing turns upward, live (P5
   * Task 4) — every messages change, not debounced like persist above: the
   * dock's Checkpoints section should reflect a just-landed post-checkpoint
   * as promptly as the footer does. `checkpoint` only exists once a turn's
   * `{kind:"checkpoint",when:"post"}` item has folded in (reduceMessage), so
   * a still-running turn is naturally excluded.
   *
   * Guarded (final-review fix) against firing on every unrelated `messages`
   * mutation: the parent wires `onCheckpoints={setCoderCheckpoints}`, a raw
   * `useState` setter, and this effect used to build a brand-new array on
   * EVERY call regardless of whether any checkpoint actually changed — a new
   * array reference never bails out of React's `Object.is` check, so every
   * streamed token during a turn (many `setMessages` calls per second) was
   * cascading a full `SessionWorkspace` re-render (file browser, terminals,
   * ContextDock included). `sameCheckpointItems` compares the list by value
   * against the last list we actually emitted; only a real change (a new
   * checkpoint-bearing turn, or a summary's counts changing) calls upward. */
  useEffect(() => {
    if (!onCheckpointsRef.current) return;
    const items = messages
      .filter((m): m is AssistantMessage => m.role === "assistant")
      .filter((m): m is AssistantMessage & { turnId: string; checkpoint: CheckpointSummary } =>
        Boolean(m.turnId && m.checkpoint),
      )
      .map((m) => ({ turnId: m.turnId, checkpoint: m.checkpoint }));
    if (sameCheckpointItems(lastCheckpointsRef.current, items)) return;
    lastCheckpointsRef.current = items;
    onCheckpointsRef.current(items);
  }, [messages]);

  /* One turn — SERVER-AUTHORITATIVE: the machine journals every item, so
     this function is only a follower.
     Self-healing paths:
     - "busy" (409, a narrow client/server phase-view TOCTOU race — the
       COMMON busy case now auto-queues server-side, see "queued" below):
       the send was rejected outright and never recorded server-side, so
       queue it ourselves (`queueCoder`) rather than lose it, then reconcile.
     - "queued" (202): the server already recorded this send — either
       auto-queued behind the running turn, or started immediately if the
       runner had gone idle by the time it landed. Nothing to resend; just
       reconcile (`settleAfterTurn` below).
     - "turn_failed"/"not_started": the conversation was dropped server-side
       — re-mint via begin() (which re-opens, or re-creates if the id is
       gone) and resend ONCE.
     - CONNECTION DROP mid-turn: the turn keeps running server-side; we
       re-attach from the last seen seq (request cards replay too) and keep
       trying for ~6 minutes. A full page reload resumes the same turn via
       begin()'s server-authoritative fetchCoderTurn (using the persisted
       conversationId), NOT via the sessionStorage anchor below — those
       writes are currently vestigial (nothing reads the anchor back),
       ledgered for a P2 cleanup rather than removed here.
     There is no client outbox (P4 Task 4 retired it): every one of the
     above paths reconciles against the SERVER queue (`queue` state, synced
     from `/turn`) instead of a local array. */
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
        // A resumed turn already has its turnId (from /turn); a genuinely
        // new send doesn't yet — the "turn" journal item below stamps it in
        // once the server assigns one.
        { role: "assistant", blocks: [], at, ...(resume?.turnId ? { turnId: resume.turnId } : {}) },
      ]);
      const activeCid = cidRef.current;
      const flags = { busy: false, queued: false, failed: false, ended: false };
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
        const liveMode = modeFromEvent(item);
        if (
          liveMode === "plan" ||
          liveMode === "default" ||
          liveMode === "accept-edits"
        ) {
          setMode(liveMode);
        }
        if (item.kind === "turn") {
          turnId = item.turnId;
          saveAnchor();
          // Stamp turnId onto the live message too (P5 Task 4) — this is
          // the ONE place a freshly-sent turn's id becomes known; the
          // checkpoint footer needs it once the turn finishes.
          setMessages((prev) => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last && last.role === "assistant") {
              next[next.length - 1] = { ...last, turnId: item.turnId };
            }
            return next;
          });
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
            // reduceMessage (not a hand-rolled object literal) so this
            // fold never drops `turnId`/`checkpoint` the way reconstructing
            // `{role:"assistant", at, blocks}` from scratch would (P5 Task
            // 4) — "turn" items are handled above and never reach here, so
            // `turnId` just passes through unchanged; "checkpoint" items
            // (not otherwise handled) DO reach here, which is exactly what
            // folds a turn's post-checkpoint summary onto the message.
            next[next.length - 1] = reduceMessage(last, item);
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
        const sendResult = await sendCoder(activeCid, text, sendId, sessionId, consume);
        if (sendResult.kind === "queued") {
          flags.queued = true;
          flags.ended = true;
        }
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
            // Spread `last` (P5 Task 4) so `turnId`/`checkpoint` survive
            // this reconstruction instead of silently resetting to
            // undefined — same reasoning as reduceMessage's fold above.
            next[next.length - 1] = {
              ...last,
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
      /* Reconcile against the server queue after a turn we were following
         is no longer running — whether it just ended normally (in which
         case a queued follow-up may have ALREADY auto-drained into a fresh
         turn server-side, P4b's `_maybe_drain_queue`) or we're resolving a
         busy/queued collision. The server queue is the source of truth. */
      const settleAfterTurn = async (): Promise<void> => {
        if (!activeCid) {
          setPhase("ready");
          return;
        }
        const state = await fetchCoderTurn(activeCid, sessionId);
        if (!state) {
          // Couldn't reach the workspace to reconcile — don't silently
          // drop back to "ready" as if nothing were queued; the busy-retry
          // effect below re-runs this SAME reconciliation shortly (P4
          // final-review, Important B — it used to just flip back to
          // "ready" unconditionally, stranding the QueueStrip out of sync;
          // it now actually retries fetchCoderTurn+setQueue until it lands).
          setPhase("busy");
          return;
        }
        // Guarded (Important A): a poll/settle landing mid-edit must not
        // blow away `editingQueued`'s target queue entry out from under
        // the user's in-progress edit — see `editingQueuedRef` above.
        if (!editingQueuedRef.current) setQueue(state.queue ?? []);
        setLease(state.lease ?? null);
        if (state.turn?.status === "running") {
          // Attach to the RUNNING turn and render it live — the bottom of
          // the chat shows the CURRENT state, with Stop on the active
          // message.
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
        setPhase("ready");
      };

      if (flags.busy) {
        // 409 TOCTOU race: the send was rejected outright and never
        // recorded server-side (the common busy case auto-queues via 202
        // instead — see `flags.queued`). Roll back the optimistic bubbles
        // and queue it ourselves so the text isn't lost.
        setMessages((prev) => prev.slice(0, -2));
        const qSendId = sendId ?? crypto.randomUUID();
        const queued = activeCid
          ? await queueCoder(activeCid, text, qSendId, sessionId)
          : { ok: false as const };
        if (!queued.ok) {
          setMessages((prev) => [
            ...prev,
            {
              role: "assistant",
              blocks: [
                {
                  kind: "text",
                  text: `⚠ Could not queue "${text}" — the coding agent may be unreachable. Try sending it again.`,
                },
              ],
              at: Date.now(),
            },
          ]);
          setPhase("ready");
          return;
        }
        await settleAfterTurn();
      } else if (flags.queued) {
        // 202: the server already recorded this send (auto-queued behind
        // the running turn, or started immediately if the runner had gone
        // idle by the time it landed) — roll back the optimistic bubbles
        // and reconcile the UI against the server.
        setMessages((prev) => prev.slice(0, -2));
        await settleAfterTurn();
      } else if (flags.failed && !isRetry) {
        setMessages((prev) => prev.slice(0, -2));
        const outcome = await begin(); // re-mints a ticket, re-opens (or re-creates) the conversation
        // Only resend when begin() opened a genuinely IDLE conversation.
        // "resumed" means begin() itself already found and fully replayed a
        // running turn on the reopened conversation — that may well be this
        // exact send having landed server-side despite our client seeing
        // turn_failed/not_started; resending on top would risk asking the
        // same thing twice. "failed" means it never opened at all.
        if (outcome === "ready") {
          await runTurnRef.current?.(text, true, sendId);
        }
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
            // Spread `last` (P5 Task 4, also restores the `at` this literal
            // was previously dropping) so `turnId`/`checkpoint` survive.
            next[next.length - 1] = {
              ...last,
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
        // A queued follow-up may have already auto-drained into a fresh
        // turn the instant this one closed (P4b) — catch up to it live
        // instead of leaving the panel stuck on "ready" while a turn is
        // actually running.
        await settleAfterTurn();
      }
    },
    [sessionId, begin, anchorKey],
  );
  runTurnRef.current = runTurn;

  /* Lightly poll /turn while a turn streams, purely to keep the QueueStrip
     in sync with the server-authoritative queue — it has no live event
     channel of its own (unlike mode, which rides StatusUpdate events), so
     an edit/removal from another tab, or a drain the moment this turn
     ends, would otherwise only show up on the next reload.

     Skips the `setQueue` overwrite while an edit is in flight
     (`editingQueuedRef`, P4 final-review Important A) — a tick landing
     between the user's edit and their commit must not blow away
     `editingQueued`'s target out from under `commitQueuedEdit`'s
     about-to-run sendId lookup (defense in depth; the sendId-keying above
     is the primary fix). */
  useEffect(() => {
    if (phase !== "streaming" || !cid) return;
    const t = window.setInterval(() => {
      void fetchCoderTurn(cid, sessionId).then((state) => {
        if (!state) return;
        if (!editingQueuedRef.current) setQueue(state.queue ?? []);
        setLease(state.lease ?? null);
      });
    }, 5000);
    return () => window.clearInterval(t);
  }, [phase, cid, sessionId]);

  /* Queue a follow-up (P4b) instead of starting it now — server-backed, so
     it survives this tab closing. Shows immediately as a queued bubble;
     reconciled against the server on failure. */
  const submitQueue = useCallback(() => {
    const text = input.trim();
    if (!text || !cid) return;
    setInput("");
    const sendId = crypto.randomUUID();
    setQueue((prev) => [...prev, { sendId, input: text }]);
    void queueCoder(cid, text, sendId, sessionId).then((res) => {
      if (res.ok) return;
      // Never delivered — drop the optimistic bubble and hand the text
      // back to the composer rather than lose it.
      setQueue((prev) => prev.filter((e) => e.sendId !== sendId));
      setInput((cur) => (cur ? cur : text));
    });
  }, [input, cid, sessionId]);

  /* Redirect the RUNNING turn without ending it (P4a). Clearing the input
     immediately is the optimistic feedback; the actual "steered: <text>"
     marker row renders itself once the SteerInput event flows back through
     the already-open turn stream (transcript.ts's reduce()). On a `no_turn`
     race (the turn ended between click and call), fall back rather than
     drop the text: queue behind whatever is now running, or send it fresh
     if the coder has gone idle. */
  const submitSteer = useCallback(async () => {
    const text = input.trim();
    if (!text || !cid) return;
    setInput("");
    const result = await steerCoder(cid, text, sessionId);
    if (result.ok) return;
    if (result.code === "no_turn") {
      const state = await fetchCoderTurn(cid, sessionId);
      if (state?.turn?.status === "running") {
        const sendId = crypto.randomUUID();
        setQueue((prev) => [...prev, { sendId, input: text }]);
        void queueCoder(cid, text, sendId, sessionId).then((res) => {
          if (res.ok) return;
          setQueue((prev) => prev.filter((e) => e.sendId !== sendId));
          setInput((cur) => (cur ? cur : text));
        });
      } else {
        void runTurn(text, false, crypto.randomUUID());
      }
      return;
    }
    // Some other failure (network, etc.) — restore the text so it isn't lost.
    setInput((cur) => (cur ? cur : text));
  }, [input, cid, sessionId, runTurn]);

  /* Start a fresh turn from idle. */
  const submitSend = useCallback(() => {
    const text = input.trim();
    if (!text || phase === "error" || !cid) return;
    setInput("");
    void runTurn(text, false, crypto.randomUUID());
  }, [input, phase, cid, runTurn]);

  const composerButtons = composerButtonsForPhase(phase);

  /* The composer's primary action (Enter, or the primary button) routes by
     phase — see `composerButtonsForPhase`. */
  const submitPrimary = useCallback(() => {
    if (composerButtons.primaryAction === "steer") void submitSteer();
    else submitSend();
  }, [composerButtons.primaryAction, submitSteer, submitSend]);

  /* Commit/cancel/remove for queued messages — backed by the server queue
     (`dequeueCoder`/`queueCoder`), not a local array. An edit that empties
     the text just removes the entry; edited text re-enqueues under a fresh
     sendId (it's a new item, not the old one resent). Optimistic: the
     server queue is the source of truth and gets reconciled on the next
     `/turn` (begin(), the streaming poll above, or settleAfterTurn()).

     Looks the edited item up by `editingQueued.sendId` in the CURRENT
     `queue`, re-deriving its index at commit time (P4 final-review,
     Important A) — `queue` may have been overwritten one or more times
     since the edit began (an auto-drain, another tab, the streaming poll),
     so the index captured when the textarea opened can no longer be
     trusted to name the same item. */
  const commitQueuedEdit = useCallback(() => {
    if (!editingQueued || !cid) return;
    const { sendId, draft } = editingQueued;
    const text = draft.trim();
    const index = queue.findIndex((e) => e.sendId === sendId);
    setEditingQueued(null);
    if (index === -1) {
      // The item is gone from our local snapshot — it may have already
      // drained into a running turn, been removed from another tab, or
      // simply reconciled away between the edit opening and this commit.
      // There's no server-side item left to attach the edit to (queuing it
      // fresh risks double-executing an original that already started, the
      // same hazard `!removed.removed` below guards against) — reconcile
      // `queue` against the server, and hand the draft back to the
      // composer rather than silently lose it (mirrors submitQueue's and
      // submitSteer's "never lose the text" fallback).
      void fetchCoderTurn(cid, sessionId).then((state) => {
        if (!state) return;
        setQueue(state.queue ?? []);
        setLease(state.lease ?? null);
      });
      if (text) setInput((cur) => (cur ? cur : text));
      return;
    }
    const old = queue[index];
    if (!text) {
      setQueue((prev) => prev.filter((e) => e.sendId !== sendId));
      void dequeueCoder(cid, old.sendId, sessionId);
      return;
    }
    const newSendId = crypto.randomUUID();
    setQueue((prev) =>
      prev.map((e) => (e.sendId === sendId ? { sendId: newSendId, input: text } : e)),
    );
    void (async () => {
      const removed = await dequeueCoder(cid, old.sendId, sessionId);
      // Gate on `removed.removed`, NOT `removed.ok`: an HTTP success with
      // `removed:false` means the old item already drained into a running
      // turn between render and commit — it's no longer "not yet started"
      // and dequeue is a deliberate no-op for it. Queuing the edited text
      // on top would run BOTH the original and the edit (the original is
      // already executing server-side; the edit would then also queue) —
      // instead, drop the edit and reconcile against the server, same as
      // any other failed half of this two-step.
      if (!removed.removed) {
        const state = await fetchCoderTurn(cid, sessionId);
        setQueue(state?.queue ?? []);
        setLease(state?.lease ?? null);
        return;
      }
      const added = await queueCoder(cid, text, newSendId, sessionId);
      if (added.ok) return;
      // The re-enqueue itself didn't land — reconcile against the server
      // rather than trust our optimistic edit.
      const state = await fetchCoderTurn(cid, sessionId);
      setQueue(state?.queue ?? []);
      setLease(state?.lease ?? null);
    })();
  }, [editingQueued, queue, cid, sessionId]);

  /* Remove a queued message. Mirrors `commitQueuedEdit`'s care (P4
     final-review, Minor E — this used to be pure fire-and-forget: it
     optimistically filtered the item out of `queue` and never looked at
     `dequeueCoder`'s result, so a failed DELETE or a `removed:false` no-op
     (already drained between render and click) left the item alive
     server-side while the UI showed it gone). Gate on `removed`, not `ok`,
     same as `commitQueuedEdit`, and reconcile from `/turn` rather than
     trust the optimistic removal when it doesn't hold. */
  const removeQueued = useCallback(
    (index: number) => {
      if (!cid) return;
      const item = queue[index];
      if (!item) return;
      setQueue((prev) => prev.filter((e) => e.sendId !== item.sendId));
      setEditingQueued((cur) => (cur && cur.sendId === item.sendId ? null : cur));
      void dequeueCoder(cid, item.sendId, sessionId).then((result) => {
        if (result.removed) return;
        void fetchCoderTurn(cid, sessionId).then((state) => {
          if (!state) return;
          setQueue(state.queue ?? []);
          setLease(state.lease ?? null);
        });
      });
    },
    [queue, cid, sessionId],
  );

  /* Busy backoff (P4 final-review, Important B): "busy" means
     settleAfterTurn()'s `fetchCoderTurn` transiently failed to reach the
     workspace while reconciling — a send/queue may have already landed
     server-side with NO local `setQueue` to show it. This effect used to
     just flip back to "ready" after a timeout with no fetch and no
     setQueue at all — the QueueStrip could silently miss a just-queued
     item, and a user who saw no queued bubble could resend, double-
     executing it server-side. It now actually RE-RUNS the same
     reconciliation settleAfterTurn does (fetchCoderTurn, then setQueue or
     attach to a running turn) instead of asserting "ready" blind; on
     another failed fetch it stays busy and retries again after
     BUSY_RETRY_MS rather than giving up. Self-scheduling (a local
     recursive setTimeout) rather than depending on `phase` to re-trigger:
     `setPhase("busy")` while already "busy" is a same-value update React
     bails out of, so re-running via the effect's own dependency array
     alone would silently stop retrying after the first failed attempt. */
  useEffect(() => {
    if (phase !== "busy" || !cid) return;
    let cancelled = false;
    let timer: number | null = null;
    const attempt = async () => {
      const state = await fetchCoderTurn(cid, sessionId);
      if (cancelled) return;
      if (!state) {
        timer = window.setTimeout(() => void attempt(), BUSY_RETRY_MS);
        return;
      }
      if (!editingQueuedRef.current) setQueue(state.queue ?? []);
      setLease(state.lease ?? null);
      if (state.turn?.status === "running") {
        void runTurnRef.current?.(
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
      setPhase("ready");
    };
    timer = window.setTimeout(() => void attempt(), BUSY_RETRY_MS);
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [phase, cid, sessionId]);

  /* Watchdog: a turn that has gone quiet gets a visible Stop control. */
  useEffect(() => {
    if (phase !== "streaming") return;
    const t = window.setInterval(() => {
      if (Date.now() - lastItemAtRef.current > STALL_AFTER_MS) setStalled(true);
    }, 10_000);
    return () => window.clearInterval(t);
  }, [phase]);

  const stopTurn = useCallback(() => {
    if (!cid) return;
    void cancelCoder(cid, sessionId);
    setStalled(false);
    // A cancelled stream ends on its own; "busy" clears via its retry timer.
  }, [cid, sessionId]);

  /* Clear any pending "mode switch failed" notice on unmount. */
  useEffect(() => {
    return () => {
      if (modeNoticeTimerRef.current !== null) {
        window.clearTimeout(modeNoticeTimerRef.current);
      }
    };
  }, []);

  /* Optimistic mode switch: flip local state immediately, then confirm with
     the server. A rejection (e.g. a busy conversation — carried forward from
     P2a, ledgered rather than fixed here) reverts to the prior mode and
     surfaces the error briefly next to the control. */
  const switchMode = useCallback(
    (next: CoderMode) => {
      if (!cid || next === mode) return;
      const prev = mode;
      setMode(next);
      setModeNotice(null);
      void setCoderMode(cid, next, sessionId).then((result) => {
        if (result.ok) return;
        // Revert only if nothing superseded our optimistic value — a live
        // StatusUpdate that already moved `mode` on (e.g. the server's real
        // mode arrived mid-flight) is authoritative and must not be
        // clobbered by this stale pre-click snapshot.
        setMode((cur) => (cur === next ? prev : cur));
        setModeNotice(result.message ?? "Could not switch modes — try again.");
        if (modeNoticeTimerRef.current !== null) {
          window.clearTimeout(modeNoticeTimerRef.current);
        }
        modeNoticeTimerRef.current = window.setTimeout(
          () => setModeNotice(null),
          4000,
        );
      });
    },
    [cid, mode, sessionId],
  );

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
            // reduceMessage (P5 Task 4) so `turnId`/`checkpoint` survive
            // this out-of-order fold (mi may be an EARLIER message than the
            // live tail — same reasoning as consume()'s fold above).
            next[mi] = reduceMessage(m, {
              kind: "request_resolved",
              requestId,
              requestType,
              resolution: payload as unknown as Record<string, unknown>,
            });
          }
          return next;
        });
      } else if (result.code === "request_gone") {
        setMessages((prev) => {
          const next = [...prev];
          const m = next[mi];
          if (m && m.role === "assistant") {
            next[mi] = reduceMessage(m, { kind: "request_cancelled", requestId });
          }
          return next;
        });
      } else {
        setMessages((prev) => {
          const next = [...prev];
          const m = next[mi];
          if (m && m.role === "assistant") {
            next[mi] = {
              ...m,
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

  // 1-based ordinal among this conversation's checkpointed turns, keyed by
  // message index — the footer/RevertConfirm's human-readable "turn N" (P5
  // Task 4); turnId itself (opaque) drives every actual call. The final `n`
  // is also this conversation's TOTAL checkpoint count — RevertConfirm
  // needs it (via CheckpointFooter's `totalCheckpoints`) to tell whether
  // the turn being reverted is the latest one (P5 Task 4 review, Important:
  // only the latest turn's own pre..post diff is the FULL revert impact).
  const checkpointOrdinal = new Map<number, number>();
  let totalCheckpoints = 0;
  messages.forEach((m, i) => {
    if (m.role === "assistant" && m.turnId && m.checkpoint) {
      totalCheckpoints += 1;
      checkpointOrdinal.set(i, totalCheckpoints);
    }
  });
  const composerDisabled = phase === "error";
  const modeDisabled = !cid || phase === "error" || phase === "starting";
  // Lease status line (P6a Tasks 3+4) — null (renders nothing) unless it's
  // worth saying: a revert in progress, or another conversation holding
  // the workspace write-lease. Never repeats "you're running a turn" —
  // that's already the statusStrip above.
  const leaseNotice = leaseStatusLabel(lease, cid);

  return (
    <div style={s.wrap}>
      <div style={s.header}>
        <span style={s.title}>Coder</span>
        <span style={s.subtitle}>Works directly in your workspace</span>
        {onSwitchConversation && onCreateConversation && (
          <ConversationSwitcher
            sessionId={sessionId}
            activeId={cid}
            onSelect={onSwitchConversation}
            onCreate={onCreateConversation}
            creating={creatingConversation}
          />
        )}
      </div>

      <div style={s.transcript} ref={scrollRef}>
        {messages.length === 0 && queue.length === 0 && phase !== "error" && (
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
                      return <ToolCard key={bi} block={b} />;
                    if (b.kind === "plan")
                      return <PlanCard key={bi} block={b} />;
                    if (b.kind === "steer")
                      return (
                        <div key={bi} style={s.steerMarker}>
                          steered: {b.text}
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
                  {/* Checkpoint footer (P5 Task 4) — only once the turn's
                      post-checkpoint has landed (m.checkpoint is undefined
                      for a still-running turn). Human-only Review/Revert. */}
                  {cid && m.turnId && m.checkpoint && (
                    <CheckpointFooter
                      cid={cid}
                      sessionId={sessionId}
                      turnId={m.turnId}
                      turnNumber={checkpointOrdinal.get(mi) ?? 1}
                      totalCheckpoints={totalCheckpoints}
                      checkpoint={m.checkpoint}
                      onReverted={() => onReverted?.()}
                    />
                  )}
                </div>
              )}
            </Fragment>
          );
        })}

        {/* QueueStrip (P4b) — the SERVER queue, editable/removable, sitting
            between the last turn and the composer. */}
        {queue.map((entry, i) => (
          <div key={entry.sendId} style={s.userRow}>
            {editingQueued?.sendId === entry.sendId ? (
              <textarea
                autoFocus
                style={s.queuedEdit}
                value={editingQueued.draft}
                rows={2}
                onChange={(e) =>
                  setEditingQueued({ sendId: entry.sendId, draft: e.target.value })
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
                {entry.input}
                <span style={s.queuedTag}>{queueEntryLabel(entry)}</span>
                <span style={s.queuedActions}>
                  <button
                    type="button"
                    style={s.queuedAction}
                    title="Edit before it sends"
                    aria-label="Edit queued message"
                    onClick={() =>
                      setEditingQueued({ sendId: entry.sendId, draft: entry.input })
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
                ? // The only path that still reaches "busy" (P4 Task 4 review,
                  // Minor #5) is settleAfterTurn()'s fetchCoderTurn call
                  // coming back null — a transient unreachable workspace
                  // while reconciling, not "finishing an earlier turn" (that
                  // case now self-heals immediately via settleAfterTurn's
                  // attach-if-running instead of parking here). The 4s
                  // busy-retry timer below is what actually retries.
                  "Couldn't reach the workspace — retrying shortly…"
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

      <div style={s.modeRow}>
        <div style={s.modeSegments} role="group" aria-label="Permission mode">
          {MODE_OPTIONS.map((opt) => {
            const active = mode === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                style={{
                  ...(active ? button.primary(size.sm) : button.secondary(size.sm)),
                  ...disabled(modeDisabled),
                }}
                disabled={modeDisabled}
                aria-pressed={active}
                onClick={() => switchMode(opt.value)}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
        <span style={s.modeCaption}>{MODE_CAPTIONS[mode]}</span>
        {modeNotice && <span style={s.modeNotice}>⚠ {modeNotice}</span>}
      </div>

      {/* Lease status (P6a Task 3) — a revert in progress, or another
          conversation holding the workspace write-lease. Minimal by
          design: one line, no separate dismissable banner. */}
      {leaseNotice && <div style={s.leaseNotice}>{leaseNotice}</div>}

      <div style={s.composer}>
        <textarea
          style={s.textarea}
          placeholder={
            phase === "starting" ? "Starting the coding agent…" : "Ask the coder…"
          }
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submitPrimary();
            }
          }}
          disabled={composerDisabled}
          rows={2}
        />
        {composerButtons.showQueue && (
          <button
            type="button"
            style={s.queueBtn}
            onClick={submitQueue}
            disabled={!input.trim() || composerDisabled}
            title="Queue this message for after the current turn ends"
          >
            Queue
          </button>
        )}
        <button
          style={s.sendBtn}
          onClick={submitPrimary}
          disabled={!input.trim() || composerDisabled}
        >
          {composerButtons.primaryLabel}
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
  steerMarker: {
    fontSize: "0.76rem",
    fontStyle: "italic",
    color: "var(--ink-muted)",
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
  modeRow: {
    display: "flex",
    flexDirection: "column",
    gap: "0.3rem",
    padding: "0.55rem 0.85rem 0",
  },
  modeSegments: {
    display: "inline-flex",
    gap: "0.4rem",
    flexWrap: "wrap",
  },
  modeCaption: {
    fontSize: "0.72rem",
    lineHeight: 1.4,
    color: "var(--ink-muted)",
  },
  modeNotice: {
    fontSize: "0.72rem",
    lineHeight: 1.4,
    color: "var(--ink)",
  },
  leaseNotice: {
    fontSize: "0.72rem",
    lineHeight: 1.4,
    color: "var(--ink-soft)",
    padding: "0.3rem 0.85rem 0",
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
  queueBtn: {
    background: "var(--paper)",
    color: "var(--ink)",
    border: "1px solid var(--rule-strong)",
    borderRadius: "var(--radius-pill)",
    fontSize: "0.82rem",
    fontWeight: 600,
    padding: "0.45rem 1.1rem",
    cursor: "pointer",
  },
};
