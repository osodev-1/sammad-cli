import type { ChangePlan } from "@/lib/blueprint/api";
import type { StoredArchitectMessage } from "@/lib/sessions/state";

/**
 * The Architect chat's live transcript model, plus its mapping to the
 * persisted form (lib/sessions/state.ts `architect`).
 *
 * Live plan blocks carry denormalized display fields (summary/files) so the
 * card renders without the full ChangePlan — which is present only while the
 * plan is actionable. A restore never resurrects an applyable plan: pending
 * drafts from a dead session become "expired" (stale preconditions, and the
 * runner's working memory is gone).
 */

export type Block =
  | { kind: "text"; text: string }
  | { kind: "tool"; label: string }
  | {
      kind: "plan";
      summary: string;
      files: number;
      /** Display-only extras, not persisted. */
      edges?: number;
      updated?: number;
      state: "pending" | "applied" | "expired";
      txId?: string;
      /** Present only while actionable (this session, not yet applied). */
      plan?: ChangePlan;
    };

export type Message =
  { role: "user"; text: string } | { role: "assistant"; blocks: Block[] };

const MAX_MESSAGES = 60;
const MAX_TEXT = 6000;
const MAX_USER_TEXT = 8000;
const MAX_BLOCKS = 80;

const clip = (s: string, n: number) =>
  s.length > n ? `${s.slice(0, n - 1)}…` : s;

/** Serialize the live transcript for uiState — capped, plans reduced to record. */
export function toStored(messages: Message[]): StoredArchitectMessage[] {
  return messages.slice(-MAX_MESSAGES).map((m): StoredArchitectMessage => {
    if (m.role === "user") {
      return { role: "user", text: clip(m.text, MAX_USER_TEXT) };
    }
    return {
      role: "assistant",
      blocks: m.blocks.slice(0, MAX_BLOCKS).map((b) => {
        if (b.kind === "text") {
          return { kind: "text" as const, text: clip(b.text, MAX_TEXT) };
        }
        if (b.kind === "tool") {
          return { kind: "tool" as const, label: clip(b.label, 200) };
        }
        return {
          kind: "plan" as const,
          summary: clip(b.summary, 300),
          files: Math.min(b.files, 50),
          state:
            b.state === "applied" ? ("applied" as const) : ("expired" as const),
          ...(b.txId ? { txId: b.txId } : {}),
        };
      }),
    };
  });
}

/** Rehydrate a stored transcript into the live model (plans stay inert). */
export function fromStored(stored: StoredArchitectMessage[]): Message[] {
  return stored.map((m): Message => {
    if (m.role === "user") return { role: "user", text: m.text };
    return {
      role: "assistant",
      blocks: m.blocks.map((b): Block => {
        if (b.kind === "plan") {
          return {
            kind: "plan",
            summary: b.summary,
            files: b.files,
            state: b.state,
            txId: b.txId,
          };
        }
        return b;
      }),
    };
  });
}
