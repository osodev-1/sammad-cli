import { parseSessionGrant } from "@/lib/terminal/protocol";
import { withSession } from "@/lib/terminal/workspace-model";
import { streamNdjson } from "@/lib/ndjson";
import type { CoderDiff, CoderItem, CoderTurnState, RespondPayload } from "./types";

/** CoderPanel's phase machine (P1b + P4). Exported so pure routing helpers
 * below (and their tests) share the exact same type the component uses —
 * no risk of the two drifting apart. */
export type CoderPhase =
  | "idle"
  | "starting"
  | "ready"
  | "streaming"
  | "busy"
  | "error";

export interface EnsureResult {
  ok: boolean;
  conversationId?: string;
  error?: string;
  errorCode?: string;
}

/** Fallback copy for codes the server sometimes omits a message for — kept
 * distinct per the product panels each renders (coder vs terminal gate vs
 * the live-conversation cap). */
const FALLBACK_ERROR_MESSAGES: Record<string, string> = {
  coder_not_enabled: "The coding agent is not enabled for this account.",
  terminal_not_enabled: "The web workspace is not enabled for this account.",
  conversation_limit: "Too many conversations are running — stop one first.",
};

function describeError(
  code: string | undefined,
  message: string | undefined,
  fallback: string,
): string {
  if (message) return message;
  if (code && FALLBACK_ERROR_MESSAGES[code]) return FALLBACK_ERROR_MESSAGES[code];
  return fallback;
}

type MintResult =
  | { ok: true; ticket: string }
  | { ok: false; error: string; errorCode?: string };

/** Mint a one-time terminal ticket (also wakes the machine). Every caller
 * that needs to redeem a ticket (open, create) must mint its own — tickets
 * are single-use. */
async function mintTicket(sessionId?: string): Promise<MintResult> {
  try {
    const mint = await fetch("/api/terminal/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(sessionId ? { sessionId } : {}),
    });
    if (!mint.ok) {
      const b = await mint.json().catch(() => null);
      const code = b?.error?.code as string | undefined;
      return {
        ok: false,
        error: describeError(code, b?.error?.message, "The workspace is not ready yet."),
        errorCode: code,
      };
    }
    const grant = parseSessionGrant(await mint.json().catch(() => null));
    if (!grant) return { ok: false, error: "Could not reach the workspace." };
    return { ok: true, ticket: grant.ticket };
  } catch {
    return { ok: false, error: "Network error — check your connection." };
  }
}

/**
 * Mint a terminal ticket, then open the existing conversation or create a
 * new one. Mirrors startArchitect's two-step. Tickets are one-time: if the
 * open falls through to create (stale/unknown conversation id), a SECOND
 * ticket is minted for the create redemption.
 */
export async function ensureConversation(
  existingId: string | undefined,
  sessionId?: string,
): Promise<EnsureResult> {
  if (existingId) {
    const mint1 = await mintTicket(sessionId);
    if (!mint1.ok) return mint1;

    let openRes: Response;
    try {
      openRes = await fetch(
        withSession(
          `/api/coder/conversations/${encodeURIComponent(existingId)}/open`,
          sessionId,
        ),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ticket: mint1.ticket }),
        },
      );
    } catch {
      return { ok: false, error: "Network error — check your connection." };
    }

    if (openRes.ok) {
      return { ok: true, conversationId: existingId };
    }

    const b = await openRes.json().catch(() => null);
    const code = b?.error?.code as string | undefined;
    const fallsThrough =
      openRes.status === 404 || (openRes.status === 400 && code === "invalid_conversation");
    if (!fallsThrough) {
      return {
        ok: false,
        error: describeError(code, b?.error?.message, "Could not open the conversation."),
        errorCode: code,
      };
    }
    // fall through to create, below — minting a fresh one-time ticket for it
  }

  const mint2 = await mintTicket(sessionId);
  if (!mint2.ok) return mint2;

  let createRes: Response;
  try {
    createRes = await fetch(withSession("/api/coder/conversations", sessionId), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ticket: mint2.ticket }),
    });
  } catch {
    return { ok: false, error: "Network error — check your connection." };
  }

  if (!createRes.ok) {
    const b = await createRes.json().catch(() => null);
    const code = b?.error?.code as string | undefined;
    return {
      ok: false,
      error: describeError(code, b?.error?.message, "Could not start the coding agent."),
      errorCode: code,
    };
  }

  const body = await createRes.json().catch(() => null);
  const data = body?.data ?? body;
  const conversationId = data?.conversationId as string | undefined;
  if (!conversationId) {
    return { ok: false, error: "Could not start the coding agent." };
  }
  return { ok: true, conversationId };
}

/** Outcome of a `sendCoder` call: either it streamed a turn live, or the
 * server answered "queued" instead (see `isQueuedSendResponse` below) — the
 * caller reconciles the latter against the server queue (`/turn`'s `queue`)
 * rather than treating it as turn content. */
export type SendResult = { kind: "streamed" } | { kind: "queued"; position?: number };

/**
 * LOAD-BEARING (P4 Task 2 review finding): a busy `/send` now auto-queues
 * server-side instead of 409ing — it answers HTTP 202 with a JSON envelope
 * `{"ok":true,"queued":true,"position":n}`, not an NDJSON stream. Because of
 * the client/server phase-view race, `sendCoder` (the IDLE send path) CAN
 * still hit a running turn and get this 202 back. A 202 must NEVER reach
 * `streamNdjson` — `res.status === 202` is the authoritative signal; a
 * non-ndjson content-type on any other 2xx is a defense-in-depth backstop
 * for the same failure mode. Pure so it's testable without a live Response. */
export function isQueuedSendResponse(status: number, contentType: string | null): boolean {
  if (status === 202) return true;
  return status >= 200 && status < 300 && !(contentType ?? "").includes("ndjson");
}

/**
 * Start one turn, invoking `onItem` per streamed item. The server journals
 * the turn independently of this connection: on a drop, the caller re-attaches
 * with `followCoder` from the last seen seq — nothing is lost.
 * `sendId` makes the POST idempotent (a retry re-attaches, never re-prompts).
 *
 * Returns `{kind:"streamed"}` once the stream (or an error item pushed via
 * `onItem`) has been fully handled, or `{kind:"queued", position}` when the
 * send landed on a busy runner and got auto-queued instead (see
 * `isQueuedSendResponse` above) — `onItem` is never called in that case.
 */
export async function sendCoder(
  cid: string,
  input: string,
  sendId: string | undefined,
  sessionId: string | undefined,
  onItem: (i: CoderItem) => void,
  signal?: AbortSignal,
): Promise<SendResult> {
  let res: Response;
  try {
    res = await fetch(
      withSession(`/api/coder/conversations/${encodeURIComponent(cid)}/send`, sessionId),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input, sendId }),
        signal,
      },
    );
  } catch {
    onItem({
      kind: "error",
      code: "network",
      message: "Network error — check your connection.",
    });
    return { kind: "streamed" };
  }
  if (isQueuedSendResponse(res.status, res.headers.get("content-type"))) {
    const b = await res.json().catch(() => null);
    const data = b?.data ?? b;
    return {
      kind: "queued",
      position: typeof data?.position === "number" ? data.position : undefined,
    };
  }
  if (!res.ok || !res.body) {
    const b = await res.json().catch(() => null);
    onItem({
      kind: "error",
      code: b?.error?.code,
      turnId: b?.error?.turnId,
      message: b?.error?.message ?? "The coding agent could not respond.",
    });
    return { kind: "streamed" };
  }
  await streamNdjson<CoderItem>(res, onItem);
  return { kind: "streamed" };
}

/**
 * Queue a follow-up message server-side instead of starting it now (P4b) —
 * it drains automatically once the running turn ends, even with this tab
 * closed. RAM-only server-side: lost on a crash/restart (re-typable, not a
 * data-loss concern). `sendId` is required here (unlike `sendCoder`'s
 * optional one) — it's the queue entry's own key, and how `dequeueCoder`
 * removes it later. Never throws — a failed queue attempt surfaces as
 * `{ok:false, code}` for the caller to fall back on (e.g. re-showing the
 * composer).
 */
export async function queueCoder(
  cid: string,
  input: string,
  sendId: string,
  sessionId?: string,
): Promise<{ ok: boolean; queued?: boolean; position?: number; code?: string }> {
  try {
    const res = await fetch(
      withSession(`/api/coder/conversations/${encodeURIComponent(cid)}/send`, sessionId),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input, sendId, queue: true }),
      },
    );
    const b = await res.json().catch(() => null);
    if (res.ok) {
      const data = b?.data ?? b;
      return { ok: true, queued: Boolean(data?.queued), position: data?.position };
    }
    return { ok: false, code: b?.error?.code };
  } catch {
    return { ok: false, code: "network" };
  }
}

/** Remove a not-yet-started queued follow-up. Never throws — a failed
 * dequeue surfaces as `{ok:false}` and the item just stays queued. */
export async function dequeueCoder(
  cid: string,
  sendId: string,
  sessionId?: string,
): Promise<{ ok: boolean; removed?: boolean }> {
  try {
    const res = await fetch(
      withSession(
        `/api/coder/conversations/${encodeURIComponent(cid)}/queue/${encodeURIComponent(sendId)}`,
        sessionId,
      ),
      { method: "DELETE" },
    );
    const b = await res.json().catch(() => null);
    if (res.ok) {
      const data = b?.data ?? b;
      return { ok: true, removed: Boolean(data?.removed) };
    }
    return { ok: false };
  } catch {
    return { ok: false };
  }
}

/** Re-attach to a journaled turn from a seq (replay the gap, then live). */
export async function followCoder(
  cid: string,
  turnId: string,
  fromSeq: number,
  sessionId: string | undefined,
  onItem: (i: CoderItem) => void,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(
      withSession(
        `/api/coder/conversations/${encodeURIComponent(cid)}/follow?turnId=${encodeURIComponent(turnId)}&from_seq=${fromSeq}`,
        sessionId,
      ),
    );
  } catch {
    onItem({ kind: "error", code: "network", message: "Network error." });
    return;
  }
  if (!res.ok || !res.body) {
    const b = await res.json().catch(() => null);
    onItem({
      kind: "error",
      code: b?.error?.code ?? "network",
      message: b?.error?.message ?? "Could not re-attach to the turn.",
    });
    return;
  }
  await streamNdjson<CoderItem>(res, onItem);
}

/** Last turn's state, plus any pending approval/question requests. Null when
 * the workspace is unreachable. */
export async function fetchCoderTurn(
  cid: string,
  sessionId?: string,
): Promise<CoderTurnState | null> {
  try {
    const res = await fetch(
      withSession(`/api/coder/conversations/${encodeURIComponent(cid)}/turn`, sessionId),
    );
    if (!res.ok) return null;
    const body = await res.json();
    const data = body?.data ?? body;
    return {
      turn: data?.turn ?? null,
      alive: Boolean(data?.alive),
      pendingRequests: data?.pendingRequests ?? [],
      mode: data?.mode ?? undefined,
      queue: data?.queue ?? undefined,
    };
  } catch {
    return null;
  }
}

/** One turn's checkpoint diff (P5 Task 3) — name-status + unified patch,
 * `pre..post` once finished or `pre..worktree` while still running
 * (server-decided). Never throws — a failed fetch surfaces as
 * `{ok:false, code}` for the caller to show a fallback instead of crashing
 * the panel. */
export interface CoderDiffResult extends Partial<CoderDiff> {
  ok: boolean;
  code?: string;
}

export async function fetchCoderDiff(
  cid: string,
  turnId: string,
  path?: string,
  sessionId?: string,
): Promise<CoderDiffResult> {
  try {
    const qs = `turnId=${encodeURIComponent(turnId)}${path ? `&path=${encodeURIComponent(path)}` : ""}`;
    const res = await fetch(
      withSession(
        `/api/coder/conversations/${encodeURIComponent(cid)}/diff?${qs}`,
        sessionId,
      ),
    );
    const b = await res.json().catch(() => null);
    if (res.ok) {
      const data = b?.data ?? b;
      return {
        ok: true,
        nameStatus: data?.nameStatus,
        patch: data?.patch,
        truncated: data?.truncated,
        filesChanged: data?.filesChanged,
        additions: data?.additions,
        deletions: data?.deletions,
      };
    }
    return { ok: false, code: b?.error?.code };
  } catch {
    return { ok: false, code: "network" };
  }
}

/** Restore the worktree to one turn's pre-checkpoint state — human-only, no
 * agent-facing equivalent. Never throws — a failed revert surfaces as
 * `{ok:false, code, message}` so the caller can show an error and let the
 * user retry. */
export async function revertCoder(
  cid: string,
  turnId: string,
  sessionId?: string,
): Promise<{
  ok: boolean;
  safetyCheckpoint?: string;
  reverted?: { turnId: string };
  code?: string;
  message?: string;
}> {
  try {
    const res = await fetch(
      withSession(`/api/coder/conversations/${encodeURIComponent(cid)}/revert`, sessionId),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ turnId }),
      },
    );
    const b = await res.json().catch(() => null);
    if (res.ok) {
      const data = b?.data ?? b;
      return { ok: true, safetyCheckpoint: data?.safetyCheckpoint, reverted: data?.reverted };
    }
    return { ok: false, code: b?.error?.code, message: b?.error?.message };
  } catch {
    return {
      ok: false,
      code: "network",
      message: "Network error — check your connection.",
    };
  }
}

/** Whether an "interrupted" turn's reconstructed tail still needs replaying
 * into the transcript (P3 Task 4 Fix B). `lastInterruptedTurnId` is the
 * turnId CoderPanel.begin() already surfaced and persisted (uiState's
 * `coder.lastInterruptedTurnId`) — comparing against it is what keeps a
 * reload (or a begin() re-entry, e.g. the busy self-heal path) from
 * re-replaying the SAME interrupted turn and appending a duplicate message.
 * Pure so the idempotency rule is testable without mounting the panel. */
export function needsInterruptedReplay(
  turnId: string,
  lastInterruptedTurnId: string | undefined,
): boolean {
  return turnId !== lastInterruptedTurnId;
}

/** What the composer's buttons do for a given phase (P4 Task 4) — the
 * client outbox is retired, so this is the sole place the "steer-now vs
 * queue vs send" split is decided. While a turn is live (`streaming`, or
 * `busy` — a turn IS running server-side in both, `busy` just means THIS
 * client isn't currently attached to it) the primary action redirects the
 * running turn (`steerCoder`) and a secondary Queue button offers
 * `queueCoder` instead; otherwise (idle, starting, error) the composer
 * falls back to starting a fresh turn (`sendCoder`) — the composer itself
 * only ever disables on `error` (CoderPanel's `composerDisabled`), not
 * here. Pure so the routing rule is testable without mounting the panel. */
export interface ComposerButtons {
  primaryLabel: "Send" | "Steer now";
  primaryAction: "send" | "steer";
  showQueue: boolean;
}

export function composerButtonsForPhase(phase: CoderPhase): ComposerButtons {
  if (phase === "streaming" || phase === "busy") {
    return { primaryLabel: "Steer now", primaryAction: "steer", showQueue: true };
  }
  return { primaryLabel: "Send", primaryAction: "send", showQueue: false };
}

/** Resolve a pending approval/question request. Never throws — the panel
 * treats a failed respond as "still pending" and lets the user retry. */
export async function respondCoder(
  cid: string,
  requestId: string,
  payload: RespondPayload,
  sessionId?: string,
): Promise<{ ok: boolean; code?: string; message?: string }> {
  try {
    const res = await fetch(
      withSession(`/api/coder/conversations/${encodeURIComponent(cid)}/respond`, sessionId),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId, ...payload }),
      },
    );
    if (res.ok) return { ok: true };
    const b = await res.json().catch(() => null);
    return { ok: false, code: b?.error?.code, message: b?.error?.message };
  } catch {
    return {
      ok: false,
      code: "network",
      message: "Network error — check your connection.",
    };
  }
}

/** Inject a follow-up into the active turn without ending it. Never throws —
 * the panel treats a failed steer as "not delivered" (409 `no_turn` once the
 * turn has already finished is the common race) and lets the user fall back
 * to a normal send. */
export async function steerCoder(
  cid: string,
  input: string,
  sessionId?: string,
): Promise<{ ok: boolean; code?: string; message?: string }> {
  try {
    const res = await fetch(
      withSession(`/api/coder/conversations/${encodeURIComponent(cid)}/steer`, sessionId),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input }),
      },
    );
    if (res.ok) return { ok: true };
    const b = await res.json().catch(() => null);
    return { ok: false, code: b?.error?.code, message: b?.error?.message };
  } catch {
    return {
      ok: false,
      code: "network",
      message: "Network error — check your connection.",
    };
  }
}

/** Switch the live permission mode ("plan" | "default" | "accept-edits").
 * Never throws — the caller (CoderPanel) treats a failed switch as "stay on
 * the prior mode" and reverts its optimistic UI state. */
export async function setCoderMode(
  cid: string,
  mode: string,
  sessionId?: string,
): Promise<{ ok: boolean; code?: string; message?: string }> {
  try {
    const res = await fetch(
      withSession(`/api/coder/conversations/${encodeURIComponent(cid)}/mode`, sessionId),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode }),
      },
    );
    if (res.ok) return { ok: true };
    const b = await res.json().catch(() => null);
    return { ok: false, code: b?.error?.code, message: b?.error?.message };
  } catch {
    return {
      ok: false,
      code: "network",
      message: "Network error — check your connection.",
    };
  }
}

export async function cancelCoder(cid: string, sessionId?: string): Promise<void> {
  try {
    await fetch(
      withSession(`/api/coder/conversations/${encodeURIComponent(cid)}/cancel`, sessionId),
      { method: "POST" },
    );
  } catch {
    /* best-effort */
  }
}

/** Drop the conversation — the next open respawns fresh (fresh auth). */
export async function stopCoder(cid: string, sessionId?: string): Promise<void> {
  try {
    await fetch(
      withSession(`/api/coder/conversations/${encodeURIComponent(cid)}/stop`, sessionId),
      { method: "POST" },
    );
  } catch {
    /* best-effort */
  }
}

/** Assistant prose from a content event (tolerant of the exact envelope). */
export function textFromEvent(item: CoderItem): string | null {
  if (item.kind !== "event") return null;
  const text = (item.event.payload as { text?: unknown } | undefined)?.text;
  return typeof text === "string" && text ? text : null;
}

/** The model's reasoning stream (ContentPart type "think") — the live "steps"
 * revealed by expanding the turn; never part of the final answer. */
export function thinkFromEvent(item: CoderItem): string | null {
  if (item.kind !== "event") return null;
  const payload = item.event.payload as { type?: unknown; think?: unknown } | undefined;
  if (payload?.type !== "think") return null;
  return typeof payload.think === "string" && payload.think ? payload.think : null;
}

/** Live permission-mode signal off a `StatusUpdate` event. Standalone (not
 * part of `reduce()` in transcript.ts) — it's conversation-level state, not
 * a transcript block, so CoderPanel's `consume()` calls this alongside the
 * other extractors to update its own mode state directly. */
export function modeFromEvent(item: CoderItem): string | null {
  if (item.kind !== "event" || item.event.type !== "StatusUpdate") return null;
  const mode = (item.event.payload as { permission_mode?: unknown } | undefined)?.permission_mode;
  return typeof mode === "string" && mode ? mode : null;
}

/** Generic present-tense phrase per tool name — the fallback tier for
 * `toolActionLabel` (lib/coder/toolDisplay.ts) when args don't give a more
 * concrete label, and the sole source for the always-on activity line here. */
export const TOOL_LABELS: Record<string, string> = {
  Shell: "Running a command",
  WriteFile: "Writing a file",
  StrReplaceFile: "Editing a file",
  ReadFile: "Reading files",
  Grep: "Searching files",
  Glob: "Finding files",
  ReadMediaFile: "Reading media",
  SearchWeb: "Searching the web",
  FetchURL: "Fetching a page",
  SetTodoList: "Updating the plan",
  AskUserQuestion: "Asking you a question",
  EnterPlanMode: "Entering plan mode",
  ExitPlanMode: "Proposing a plan",
  Agent: "Delegating to a subagent",
  TaskList: "Checking background tasks",
  TaskOutput: "Reading task output",
  TaskStop: "Stopping a task",
};

/** Best-effort tool label for the activity line in the transcript. */
export function toolLabel(item: CoderItem): string | null {
  if (item.kind !== "event" || item.event.type !== "ToolCall") return null;
  const fn = (item.event.payload as { function?: { name?: string } } | undefined)?.function;
  const name = fn?.name ?? "";
  return TOOL_LABELS[name] ?? (name ? `Running ${name}` : "Working");
}
