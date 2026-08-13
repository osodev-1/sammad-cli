import type { ApprovalPayload, CoderItem, QuestionPayload } from "./types";
import { textFromEvent, thinkFromEvent, toolLabel } from "./client";

/**
 * The Coder chat's live transcript model (journal-folded), plus its mapping
 * to the persisted form (lib/sessions/state.ts `coder`).
 *
 * Request blocks track a resolution lifecycle (pending -> resolved |
 * cancelled) so an approval/question card can update in place as the journal
 * replays, out of order or repeated. A restore never resurrects an
 * answerable card: pending requests from a dead turn are stored — and
 * rehydrate — as "cancelled".
 */

export type RequestState = "pending" | "resolved" | "cancelled";

export type CoderBlock =
  | { kind: "text"; text: string }
  /** Live reasoning steps — shown on demand, never persisted. */
  | { kind: "think"; text: string }
  | { kind: "tool"; label: string }
  | {
      kind: "request";
      requestId: string;
      requestType: "approval" | "question";
      payload: ApprovalPayload | QuestionPayload;
      state: RequestState;
      resolution?: Record<string, unknown>;
    };

export type CoderMessage =
  | { role: "user"; text: string; at?: number }
  | { role: "assistant"; blocks: CoderBlock[]; at?: number };

type RequestBlock = Extract<CoderBlock, { kind: "request" }>;

function findRequestIndex(blocks: CoderBlock[], requestId: string): number {
  return blocks.findIndex((b) => b.kind === "request" && b.requestId === requestId);
}

/** Fold one journal item into an assistant message's blocks. Pure. */
export function reduce(blocks: CoderBlock[], item: CoderItem): CoderBlock[] {
  const think = thinkFromEvent(item);
  if (think) {
    const last = blocks[blocks.length - 1];
    if (last && last.kind === "think") {
      return [...blocks.slice(0, -1), { kind: "think", text: last.text + think }];
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

  if (item.kind === "request") {
    const idx = findRequestIndex(blocks, item.requestId);
    if (idx !== -1) {
      const existing = blocks[idx];
      // LAST-WINS: a decided (resolved/cancelled) block is frozen — a stale
      // replay of the original `request` item must never resurrect it as
      // answerable, even without updating its payload.
      if (existing.kind === "request" && existing.state !== "pending") return blocks;
    }
    const block: RequestBlock = {
      kind: "request",
      requestId: item.requestId,
      requestType: item.requestType,
      payload: item.request as unknown as ApprovalPayload | QuestionPayload,
      state: "pending",
    };
    if (idx === -1) return [...blocks, block];
    // Journal replay of the same still-pending request — replace in place,
    // preserve order.
    return [...blocks.slice(0, idx), block, ...blocks.slice(idx + 1)];
  }

  if (item.kind === "request_resolved") {
    const idx = findRequestIndex(blocks, item.requestId);
    if (idx === -1) return blocks; // unknown id — nothing to update
    const existing = blocks[idx];
    if (existing.kind !== "request") return blocks;
    // LAST-WINS: resolved always upgrades, even over a cancelled block.
    const updated: CoderBlock = {
      ...existing,
      state: "resolved",
      resolution: item.resolution,
    };
    return [...blocks.slice(0, idx), updated, ...blocks.slice(idx + 1)];
  }

  if (item.kind === "request_cancelled") {
    const idx = findRequestIndex(blocks, item.requestId);
    if (idx === -1) return blocks; // unknown id — nothing to update
    const existing = blocks[idx];
    // Never demote a resolved block: cancelled-after-resolved is ignored.
    if (existing.kind !== "request" || existing.state !== "pending") return blocks;
    const updated: CoderBlock = { ...existing, state: "cancelled" };
    return [...blocks.slice(0, idx), updated, ...blocks.slice(idx + 1)];
  }

  if (item.kind === "error" && item.code !== "busy") {
    return [
      ...blocks,
      { kind: "text", text: `⚠ ${item.message ?? "Something went wrong."}` },
    ];
  }

  // "turn", "end", silent "busy" errors, and unrecognized event payloads
  // (e.g. RequestOutcome — the request block already shows the resolution)
  // don't change the transcript.
  return blocks;
}

const MAX_MESSAGES = 60;
const MAX_BLOCKS = 80;
const MAX_TEXT = 6000;
const MAX_USER_TEXT = 8000;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function requestSummary(b: RequestBlock): string {
  if (b.requestType === "approval") {
    const p = b.payload as ApprovalPayload;
    const parts = [p.action, p.description].filter((v): v is string => Boolean(v));
    return clip(parts.join(": "), 300);
  }
  const p = b.payload as QuestionPayload;
  return clip(p.questions[0]?.question ?? "", 300);
}

function requestOutcome(b: RequestBlock): string | undefined {
  if (b.state !== "resolved" || !b.resolution) return undefined;
  if (b.requestType === "approval") {
    const response = b.resolution.response;
    return typeof response === "string" ? response : undefined;
  }
  const answers = b.resolution.answers;
  if (!answers || typeof answers !== "object") return undefined;
  const digest = Object.values(answers as Record<string, unknown>)
    .filter((v): v is string => typeof v === "string")
    .join(", ");
  return digest || undefined;
}

/** Local structural types — Task 4's zod schema in lib/sessions/state.ts MUST
 * match these shapes exactly (TS structural typing keeps them assignable). */
export type StoredCoderBlock =
  | { kind: "text"; text: string }
  | { kind: "tool"; label: string }
  | {
      kind: "request";
      requestId: string;
      requestType: "approval" | "question";
      summary: string;
      state: "resolved" | "cancelled";
      outcome?: string;
    };

export type StoredCoderMessage =
  | { role: "user"; text: string; at?: number }
  | { role: "assistant"; blocks: StoredCoderBlock[]; at?: number };

/** Serialize for uiState (caps mirror the architect: 60 msgs / 80 blocks /
 * 6000 chars; think dropped; ⚠ lines dropped; PENDING requests downgraded to
 * "cancelled" — a restored card must never look answerable). */
export function toStored(messages: CoderMessage[]): StoredCoderMessage[] {
  return messages.slice(-MAX_MESSAGES).map((m): StoredCoderMessage => {
    if (m.role === "user") {
      return {
        role: "user",
        text: clip(m.text, MAX_USER_TEXT),
        ...(m.at ? { at: m.at } : {}),
      };
    }
    return {
      role: "assistant",
      ...(m.at ? { at: m.at } : {}),
      // Reasoning steps are ephemeral, and so are transient status lines
      // (⚠ network/turn errors): a restored chat keeps answers and actions —
      // never yesterday's connection trouble presented as if it were current.
      blocks: m.blocks
        .filter(
          (b): b is Exclude<CoderBlock, { kind: "think" }> =>
            b.kind !== "think" && !(b.kind === "text" && b.text.startsWith("⚠")),
        )
        .slice(0, MAX_BLOCKS)
        .map((b): StoredCoderBlock => {
          if (b.kind === "text") return { kind: "text", text: clip(b.text, MAX_TEXT) };
          if (b.kind === "tool") return { kind: "tool", label: clip(b.label, 200) };
          const outcome = requestOutcome(b);
          return {
            kind: "request",
            requestId: b.requestId,
            requestType: b.requestType,
            summary: requestSummary(b),
            // PENDING requests never survive a restore as answerable.
            state: b.state === "resolved" ? "resolved" : "cancelled",
            ...(outcome ? { outcome } : {}),
          };
        }),
    };
  });
}

/** Rehydrate a stored transcript into the live model. Request blocks stay
 * inert: the payload is a synthetic placeholder built from the stored
 * summary (never the original request), and there's no live resolution to
 * act on — cards render `summary`/`outcome` read-only. */
export function fromStored(stored: StoredCoderMessage[]): CoderMessage[] {
  return stored.map((m): CoderMessage => {
    if (m.role === "user") return { role: "user", text: m.text, at: m.at };
    return {
      role: "assistant",
      at: m.at,
      blocks: m.blocks.map((b): CoderBlock => {
        if (b.kind !== "request") return b;
        const payload: ApprovalPayload | QuestionPayload =
          b.requestType === "approval"
            ? { id: b.requestId, action: b.summary }
            : {
                id: b.requestId,
                questions: [{ question: b.summary, options: [] }],
              };
        return {
          kind: "request",
          requestId: b.requestId,
          requestType: b.requestType,
          payload,
          state: b.state,
          ...(b.outcome !== undefined ? { resolution: { outcome: b.outcome } } : {}),
        };
      }),
    };
  });
}
