import { parseSessionGrant } from "@/lib/terminal/protocol";
import { withSession } from "@/lib/terminal/workspace-model";
import type { ChangePlan } from "@/lib/blueprint/api";

/** One item off the architect turn stream (mirrors the agentd bridge). */
export type ArchitectItem =
  | {
      kind: "event";
      event: { type?: string; payload?: Record<string, unknown> };
    }
  | { kind: "end"; status?: string }
  | { kind: "error"; message?: string; code?: string };

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

/**
 * Run one turn, invoking `onItem` for each streamed item until turn end. Parses
 * the NDJSON body line by line; malformed lines are skipped, never thrown.
 */
export async function askArchitect(
  input: string,
  sessionId: string | undefined,
  onItem: (item: ArchitectItem) => void,
  signal?: AbortSignal,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(withSession("/api/architect/ask", sessionId), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input }),
      signal,
    });
  } catch {
    onItem({
      kind: "error",
      message: "Network error — check your connection.",
    });
    return;
  }
  if (!res.ok || !res.body) {
    const b = await res.json().catch(() => null);
    onItem({
      kind: "error",
      code: b?.error?.code,
      message: b?.error?.message ?? "The architect could not respond.",
    });
    return;
  }

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
      break; // aborted or connection dropped
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
