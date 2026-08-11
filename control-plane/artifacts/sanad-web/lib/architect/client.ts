import { parseSessionGrant } from "@/lib/terminal/protocol";
import { withSession } from "@/lib/terminal/workspace-model";
import type { ChangePlan } from "@/lib/blueprint/api";

/** One item off the architect turn stream (mirrors the agentd bridge).
 * Items carry a journal `seq` — the reconnect cursor (R6 resilience). */
export type ArchitectItem =
  | {
      kind: "event";
      seq?: number;
      event: { type?: string; payload?: Record<string, unknown> };
    }
  | { kind: "turn"; seq?: number; turnId: string }
  | { kind: "end"; seq?: number; status?: string }
  | {
      kind: "error";
      seq?: number;
      message?: string;
      code?: string;
      turnId?: string;
    };

export interface StartResult {
  ok: boolean;
  error?: string;
}

/**
 * Ensure the architect subprocess is running for this session. Mints a terminal
 * ticket (which also wakes the machine, like the terminal does) and hands it to
 * the start route; agentd redeems it into a gateway session token server-side.
 */
export async function startArchitect(sessionId?: string): Promise<StartResult> {
  try {
    const mint = await fetch("/api/terminal/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(sessionId ? { sessionId } : {}),
    });
    if (!mint.ok) {
      const b = await mint.json().catch(() => null);
      return {
        ok: false,
        error: b?.error?.message ?? "The workspace is not ready yet.",
      };
    }
    const grant = parseSessionGrant(await mint.json().catch(() => null));
    if (!grant) return { ok: false, error: "Could not reach the workspace." };

    const res = await fetch(withSession("/api/architect/start", sessionId), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ticket: grant.ticket }),
    });
    if (!res.ok) {
      const b = await res.json().catch(() => null);
      return {
        ok: false,
        error: b?.error?.message ?? "Could not start the architect.",
      };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: "Network error — check your connection." };
  }
}

async function streamNdjson(
  res: Response,
  onItem: (item: ArchitectItem) => void,
): Promise<void> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const flush = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      onItem(JSON.parse(trimmed) as ArchitectItem);
    } catch {
      /* skip a partial/garbled line */
    }
  };
  for (;;) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch {
      break; // aborted or connection dropped — the caller re-follows
    }
    if (chunk.done) break;
    buf += decoder.decode(chunk.value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      flush(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  }
  flush(buf);
}

/**
 * Start one turn, invoking `onItem` per streamed item. The server journals
 * the turn independently of this connection: on a drop, the caller re-attaches
 * with `followArchitect` from the last seen seq — nothing is lost.
 * `sendId` makes the POST idempotent (a retry re-attaches, never re-prompts).
 */
export async function askArchitect(
  input: string,
  sendId: string | undefined,
  sessionId: string | undefined,
  onItem: (item: ArchitectItem) => void,
  signal?: AbortSignal,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(withSession("/api/architect/ask", sessionId), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input, sendId }),
      signal,
    });
  } catch {
    onItem({
      kind: "error",
      code: "network",
      message: "Network error — check your connection.",
    });
    return;
  }
  if (!res.ok || !res.body) {
    const b = await res.json().catch(() => null);
    onItem({
      kind: "error",
      code: b?.error?.code,
      turnId: b?.error?.turnId,
      message: b?.error?.message ?? "The architect could not respond.",
    });
    return;
  }
  await streamNdjson(res, onItem);
}

/** Re-attach to a journaled turn from a seq (replay the gap, then live). */
export async function followArchitect(
  turnId: string,
  fromSeq: number,
  sessionId: string | undefined,
  onItem: (item: ArchitectItem) => void,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(
      withSession(
        `/api/architect/follow?turnId=${encodeURIComponent(turnId)}&from_seq=${fromSeq}`,
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
  await streamNdjson(res, onItem);
}

export interface TurnSummary {
  turnId: string;
  status: "running" | "finished" | "cancelled" | "failed";
  userInput: string;
  lastSeq: number;
  startedAt: number;
}

/** Is a previous job still working? Null when unreachable. */
export async function fetchTurnState(
  sessionId?: string,
): Promise<{ turn: TurnSummary | null; alive: boolean } | null> {
  try {
    const res = await fetch(withSession("/api/architect/turn", sessionId));
    if (!res.ok) return null;
    const body = await res.json();
    const data = body?.data ?? body;
    return { turn: data?.turn ?? null, alive: Boolean(data?.alive) };
  } catch {
    return null;
  }
}

export async function cancelArchitect(sessionId?: string): Promise<void> {
  try {
    await fetch(withSession("/api/architect/cancel", sessionId), {
      method: "POST",
    });
  } catch {
    /* best-effort */
  }
}

/** Pull a drafted ChangePlan out of a ToolResult event, if present. */
export function planFromEvent(item: ArchitectItem): ChangePlan | null {
  if (item.kind !== "event" || item.event.type !== "ToolResult") return null;
  const payload = item.event.payload as
    { return_value?: { extras?: { blueprintPlan?: ChangePlan } } } | undefined;
  return payload?.return_value?.extras?.blueprintPlan ?? null;
}

/** Best-effort tool label for the activity line in the transcript. */
export function toolLabel(item: ArchitectItem): string | null {
  if (item.kind !== "event" || item.event.type !== "ToolCall") return null;
  const fn = (
    item.event.payload as { function?: { name?: string } } | undefined
  )?.function;
  const name = fn?.name ?? "";
  const labels: Record<string, string> = {
    BlueprintGraph: "Reading the blueprint",
    BlueprintValidate: "Validating the blueprint",
    DraftBlueprintChange: "Drafting a change",
    ReadFile: "Reading files",
    Grep: "Searching files",
    Glob: "Finding files",
  };
  return labels[name] ?? (name ? `Running ${name}` : "Working");
}

/** Assistant prose from a content event (tolerant of the exact envelope). */
export function textFromEvent(item: ArchitectItem): string | null {
  if (item.kind !== "event") return null;
  const text = (item.event.payload as { text?: unknown } | undefined)?.text;
  return typeof text === "string" && text ? text : null;
}

/** The model's reasoning stream (ContentPart type "think") — the live "steps"
 * revealed by clicking Architecting…; never part of the final answer. */
export function thinkFromEvent(item: ArchitectItem): string | null {
  if (item.kind !== "event") return null;
  const payload = item.event.payload as
    { type?: unknown; think?: unknown } | undefined;
  if (payload?.type !== "think") return null;
  return typeof payload.think === "string" && payload.think
    ? payload.think
    : null;
}
