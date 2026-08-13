"use client";

import { useState } from "react";
import type { CSSProperties } from "react";
import { button, chip, disabled, size, type } from "../../ui/theme";
import type { CoderBlock } from "@/lib/coder/transcript";
import type {
  ApprovalPayload,
  QuestionPayload,
  RespondPayload,
} from "@/lib/coder/types";

/**
 * Approval + Question cards for the Coder chat (P1b Task 5).
 *
 * Logic-thin by design: these components render `block` + local UI state
 * (feedback textarea open/closed, selected options, other-text) and hand a
 * well-formed `RespondPayload` back to the caller via `onRespond`. Nothing
 * here decides *whether* a request is answerable — that's `block.state`,
 * owned by lib/coder/transcript.ts's reducer (Task 3).
 *
 * Two Task-3 facts drive the non-pending rendering:
 * - A rehydrated (restored-from-session) block carries a SYNTHESIZED
 *   placeholder `payload` and, if resolved, a `resolution` shaped as
 *   `{ outcome }` — never the original wire `resolution.response` /
 *   `.answers`. `summary`/`outcome` are OPAQUE display strings (already
 *   formatted by transcript.ts's requestSummary/requestOutcome); they are
 *   never parsed here, only shown as-is.
 * - Interactivity gates EXCLUSIVELY on `block.state === "pending"`. A live
 *   resolved/cancelled block and a rehydrated one collapse to the same
 *   single-row treatment.
 */

type RequestBlock = Extract<CoderBlock, { kind: "request" }>;

/* Sentinel for the synthetic "Other" option in a question's local selection
   state — distinct from any real option label (options are user/server
   authored strings, so a NUL-prefixed key can't collide). */
const OTHER = "\u0000other";

const EXPIRED_TEXT = "Expired — the turn ended before you answered";

/* ============================================================ Approval === */

export function ApprovalCard({
  block,
  busy,
  onRespond,
}: {
  block: RequestBlock;
  busy: boolean;
  onRespond: (payload: RespondPayload) => void;
}) {
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedback, setFeedback] = useState("");

  if (block.state !== "pending") {
    return (
      <CollapsedRow
        text={approvalResolvedText(block)}
        muted={block.state === "cancelled"}
      />
    );
  }

  const payload = block.payload as ApprovalPayload;
  const source = approvalSourceLabel(payload);

  const confirmDeny = () => {
    const trimmed = feedback.trim();
    onRespond({ response: "reject", ...(trimmed ? { feedback: trimmed } : {}) });
  };

  return (
    <div style={s.card}>
      <div style={s.head}>
        <span style={type.eyebrow}>Approval needed</span>
        {payload.action && <span style={s.action}>{payload.action}</span>}
      </div>

      {source && <span style={{ ...chip, ...s.sourceChip }}>{source}</span>}

      {payload.description && (
        <div style={s.description}>{payload.description}</div>
      )}

      <div style={s.buttonRow}>
        <button
          type="button"
          style={{ ...button.primary(size.sm), ...disabled(busy) }}
          disabled={busy}
          onClick={() => onRespond({ response: "approve" })}
        >
          Allow
        </button>
        <button
          type="button"
          style={{ ...button.secondary(size.sm), ...disabled(busy) }}
          disabled={busy}
          onClick={() => onRespond({ response: "approve_for_session" })}
        >
          Allow for session
        </button>
        {!feedbackOpen && (
          <button
            type="button"
            style={{ ...button.secondary(size.sm), ...disabled(busy) }}
            disabled={busy}
            onClick={() => onRespond({ response: "reject" })}
          >
            Deny
          </button>
        )}
      </div>

      {!feedbackOpen ? (
        <button
          type="button"
          style={{ ...button.quiet(size.sm), ...disabled(busy) }}
          disabled={busy}
          onClick={() => setFeedbackOpen(true)}
        >
          Deny with feedback…
        </button>
      ) : (
        <div style={s.feedbackBlock}>
          <textarea
            autoFocus
            style={s.feedbackInput}
            value={feedback}
            placeholder="What should change?"
            rows={2}
            disabled={busy}
            onChange={(e) => setFeedback(e.target.value)}
          />
          <div style={s.buttonRow}>
            <button
              type="button"
              style={{
                ...button.secondary(size.sm),
                ...disabled(busy || feedback.trim() === ""),
              }}
              disabled={busy || feedback.trim() === ""}
              onClick={confirmDeny}
            >
              Confirm deny
            </button>
            <button
              type="button"
              style={{ ...button.quiet(size.sm), ...disabled(busy) }}
              disabled={busy}
              onClick={() => {
                setFeedbackOpen(false);
                setFeedback("");
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** `via <subagent_type>` when present; else a plain marker for a
 * background-agent-sourced request with no subagent_type on the payload. */
function approvalSourceLabel(payload: ApprovalPayload): string | null {
  if (payload.subagent_type) return `via ${payload.subagent_type}`;
  if (payload.source_kind === "background_agent") return "background agent";
  return null;
}

/** Collapsed-row text for a non-pending approval. Live resolutions carry a
 * `response` field we can branch on (it's OUR typed union, not opaque);
 * rehydrated ones carry only an opaque `outcome` string, shown verbatim. */
function approvalResolvedText(block: RequestBlock): string {
  if (block.state === "cancelled") return EXPIRED_TEXT;
  const resolution = block.resolution;
  const response =
    resolution && typeof resolution.response === "string"
      ? resolution.response
      : undefined;
  if (response) {
    const feedback =
      typeof resolution?.feedback === "string" ? resolution.feedback : undefined;
    const label =
      response === "approve"
        ? "✓ Allowed"
        : response === "approve_for_session"
          ? "✓ Allowed for session"
          : response === "reject"
            ? "✗ Denied"
            : response;
    return feedback ? `${label} — "${feedback}"` : label;
  }
  const outcome =
    resolution && typeof resolution.outcome === "string"
      ? resolution.outcome
      : undefined;
  return outcome ? `Resolved — ${outcome}` : "Resolved";
}

/* ============================================================ Question === */

type Selection = { selected: string[]; otherText: string };
const EMPTY_SELECTION: Selection = { selected: [], otherText: "" };

export function QuestionCard({
  block,
  busy,
  onRespond,
}: {
  block: RequestBlock;
  busy: boolean;
  onRespond: (payload: RespondPayload) => void;
}) {
  const [selections, setSelections] = useState<Record<number, Selection>>({});

  if (block.state !== "pending") {
    return (
      <CollapsedRow
        text={questionResolvedText(block)}
        muted={block.state === "cancelled"}
      />
    );
  }

  const payload = block.payload as QuestionPayload;
  const questions = payload.questions;

  const toggle = (qi: number, value: string, multi: boolean | undefined) => {
    setSelections((prev) => {
      const cur = prev[qi] ?? EMPTY_SELECTION;
      const selected = multi
        ? cur.selected.includes(value)
          ? cur.selected.filter((v) => v !== value)
          : [...cur.selected, value]
        : [value];
      return { ...prev, [qi]: { ...cur, selected } };
    });
  };

  const setOtherText = (qi: number, text: string) => {
    setSelections((prev) => {
      const cur = prev[qi] ?? EMPTY_SELECTION;
      return { ...prev, [qi]: { ...cur, otherText: text } };
    });
  };

  const allAnswered = questions.every((_, qi) =>
    isAnswered(selections[qi] ?? EMPTY_SELECTION),
  );

  const submit = () => {
    const answers: Record<string, string> = {};
    questions.forEach((q, qi) => {
      answers[q.question] = answerLabel(selections[qi] ?? EMPTY_SELECTION);
    });
    onRespond({ answers });
  };

  return (
    <div style={s.card}>
      {questions.map((q, qi) => {
        const sel = selections[qi] ?? EMPTY_SELECTION;
        const otherLabel = q.other_label || "Other";
        const otherActive = sel.selected.includes(OTHER);
        return (
          <div key={qi} style={s.question}>
            {q.header && <span style={{ ...chip, ...s.questionChip }}>{q.header}</span>}
            <div style={s.questionText}>{q.question}</div>
            {q.body && <div style={s.questionBody}>{q.body}</div>}

            <div style={s.optionList}>
              {q.options.map((opt) => {
                const active = sel.selected.includes(opt.label);
                return (
                  <button
                    key={opt.label}
                    type="button"
                    style={{
                      ...s.optionBtn,
                      ...(active ? s.optionBtnActive : null),
                      ...disabled(busy),
                    }}
                    disabled={busy}
                    onClick={() => toggle(qi, opt.label, q.multi_select)}
                  >
                    {q.multi_select && (
                      <span style={s.checkbox}>{active ? "☑" : "☐"}</span>
                    )}
                    <span>
                      {opt.label}
                      {opt.description && (
                        <span style={s.optionDescription}>
                          {" "}
                          — {opt.description}
                        </span>
                      )}
                    </span>
                  </button>
                );
              })}
              <button
                type="button"
                style={{
                  ...s.optionBtn,
                  ...(otherActive ? s.optionBtnActive : null),
                  ...disabled(busy),
                }}
                disabled={busy}
                onClick={() => toggle(qi, OTHER, q.multi_select)}
              >
                {q.multi_select && (
                  <span style={s.checkbox}>{otherActive ? "☑" : "☐"}</span>
                )}
                <span>{otherLabel}</span>
              </button>
            </div>

            {otherActive && (
              <input
                type="text"
                style={s.otherInput}
                value={sel.otherText}
                placeholder={q.other_description || otherLabel}
                disabled={busy}
                onChange={(e) => setOtherText(qi, e.target.value)}
              />
            )}
          </div>
        );
      })}

      <div style={s.buttonRow}>
        <button
          type="button"
          style={{
            ...button.primary(size.sm),
            ...disabled(busy || !allAnswered),
          }}
          disabled={busy || !allAnswered}
          onClick={submit}
        >
          Submit
        </button>
      </div>
    </div>
  );
}

/** A question is answered once it has at least one selection, and — if
 * "Other" is among the selections — non-empty typed text to back it. */
function isAnswered(sel: Selection): boolean {
  if (sel.selected.length === 0) return false;
  if (sel.selected.includes(OTHER) && sel.otherText.trim() === "") return false;
  return true;
}

/** Renders a question's current selection into the `answers` value: the
 * option label(s), comma-joined for multi-select; "Other" contributes its
 * typed text instead of the synthetic label. */
function answerLabel(sel: Selection): string {
  return sel.selected
    .map((v) => (v === OTHER ? sel.otherText.trim() : v))
    .filter(Boolean)
    .join(", ");
}

/** Collapsed-row text for a non-pending question. Live resolutions carry a
 * structured `answers` map we digest the same way transcript.ts does for
 * storage; rehydrated ones carry only the opaque, already-digested
 * `outcome` string, shown verbatim. */
function questionResolvedText(block: RequestBlock): string {
  if (block.state === "cancelled") return EXPIRED_TEXT;
  const resolution = block.resolution;
  const answers = resolution?.answers;
  if (answers && typeof answers === "object") {
    const digest = Object.values(answers as Record<string, unknown>)
      .filter((v): v is string => typeof v === "string")
      .join(", ");
    if (digest) return `Answered: ${digest}`;
  }
  const outcome =
    resolution && typeof resolution.outcome === "string"
      ? resolution.outcome
      : undefined;
  return outcome ? `Answered: ${outcome}` : "Answered";
}

/* ============================================================== shared === */

function CollapsedRow({ text, muted }: { text: string; muted?: boolean }) {
  return (
    <div style={{ ...s.collapsedRow, ...(muted ? s.collapsedRowMuted : null) }}>
      {text}
    </div>
  );
}

const s: Record<string, CSSProperties> = {
  card: {
    border: "1px solid var(--rule-strong)",
    borderRadius: "var(--radius-md)",
    padding: "0.75rem 0.85rem",
    display: "flex",
    flexDirection: "column",
    gap: "0.55rem",
    background: "var(--paper-sunken)",
  },
  head: { display: "flex", flexDirection: "column", gap: "0.15rem" },
  action: { fontSize: "0.9rem", fontWeight: 600, color: "var(--ink)" },
  sourceChip: { alignSelf: "flex-start" },
  description: {
    fontFamily: "var(--font-mono)",
    fontSize: "0.78rem",
    lineHeight: 1.5,
    color: "var(--ink-soft)",
    whiteSpace: "pre-wrap",
    maxHeight: "10rem",
    overflow: "auto",
    background: "var(--paper)",
    border: "1px solid var(--rule)",
    borderRadius: "var(--radius-sm)",
    padding: "0.55rem 0.7rem",
  },
  buttonRow: { display: "flex", flexWrap: "wrap", gap: "0.5rem" },
  feedbackBlock: { display: "flex", flexDirection: "column", gap: "0.5rem" },
  feedbackInput: {
    font: "inherit",
    fontSize: "0.85rem",
    lineHeight: 1.5,
    color: "var(--ink)",
    background: "var(--paper)",
    border: "1px solid var(--rule-strong)",
    borderRadius: "var(--radius-md)",
    padding: "0.5rem 0.65rem",
    resize: "vertical",
  },
  question: { display: "flex", flexDirection: "column", gap: "0.35rem" },
  questionChip: { alignSelf: "flex-start" },
  questionText: { fontSize: "0.9rem", fontWeight: 600, color: "var(--ink)" },
  questionBody: {
    fontSize: "0.82rem",
    lineHeight: 1.5,
    color: "var(--ink-soft)",
  },
  optionList: { display: "flex", flexDirection: "column", gap: "0.35rem" },
  optionBtn: {
    display: "flex",
    alignItems: "flex-start",
    gap: "0.5rem",
    textAlign: "left",
    background: "var(--paper)",
    color: "var(--ink)",
    border: "1px solid var(--rule-strong)",
    borderRadius: "var(--radius-md)",
    padding: "0.5rem 0.7rem",
    fontSize: "0.85rem",
    lineHeight: 1.4,
    cursor: "pointer",
  },
  optionBtnActive: {
    background: "var(--ink)",
    color: "var(--paper)",
    borderColor: "var(--ink)",
  },
  optionDescription: { color: "inherit", opacity: 0.75, fontWeight: 400 },
  checkbox: { fontFamily: "var(--font-mono)", flexShrink: 0 },
  otherInput: {
    font: "inherit",
    fontSize: "0.85rem",
    color: "var(--ink)",
    background: "var(--paper)",
    border: "1px solid var(--rule-strong)",
    borderRadius: "var(--radius-md)",
    padding: "0.45rem 0.65rem",
  },
  collapsedRow: {
    fontSize: "0.82rem",
    lineHeight: 1.5,
    color: "var(--ink-soft)",
    border: "1px solid var(--rule)",
    borderRadius: "var(--radius-md)",
    padding: "0.5rem 0.7rem",
    background: "var(--paper-sunken)",
  },
  collapsedRowMuted: {
    color: "var(--ink-muted)",
    fontStyle: "italic",
    borderStyle: "dashed",
  },
};
