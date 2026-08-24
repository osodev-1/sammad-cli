"use client";

import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import type { CoderBlock } from "@/lib/coder/transcript";

/**
 * Renders a `PlanDisplay` block — the plan markdown the coding agent proposes
 * right before its ExitPlanMode approve/refine question (P4 Task 3).
 *
 * Markdown -> sanitized HTML via `marked` + DOMPurify, dynamic-imported the
 * same way NotebookView.tsx and app/terminal/tabs.tsx already do — no new
 * markdown dependency, same client-only rendering path.
 *
 * This card carries NO correlation to the QuestionCard that follows it —
 * `reduce()` (lib/coder/transcript.ts) appends the plan block and the
 * ExitPlanMode question block back to back in the same turn, and rendering
 * them adjacently (this card, then CoderPanel's next block) IS the merged
 * "PlanCard" experience the task calls for. The shared "Plan" eyebrow here
 * echoes the QuestionCard's own `header` chip ("Plan") — that's the whole
 * visual association; nothing here reaches into the request block or vice
 * versa.
 */

type PlanBlock = Extract<CoderBlock, { kind: "plan" }>;

export function PlanCard({ block }: { block: PlanBlock }) {
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [{ marked }, { default: DOMPurify }] = await Promise.all([
        import("marked"),
        import("dompurify"),
      ]);
      const rendered = DOMPurify.sanitize(await marked.parse(block.content));
      if (!cancelled) setHtml(rendered);
    })().catch(() => {
      /* best-effort — falls back to the raw-text pre below */
    });
    return () => {
      cancelled = true;
    };
  }, [block.content]);

  return (
    <div style={s.card}>
      <div style={s.head}>
        <span style={s.eyebrow}>Plan</span>
        {block.filePath && <span style={s.path}>{block.filePath}</span>}
      </div>
      {html !== null ? (
        // Sanitized with DOMPurify above.
        <div style={s.markdown} dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre style={s.rawMd}>{block.content}</pre>
      )}
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
    gap: "0.5rem",
    background: "var(--paper-sunken)",
  },
  head: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: "0.5rem",
    flexWrap: "wrap",
  },
  eyebrow: {
    fontFamily: "var(--font-mono)",
    fontSize: "0.7rem",
    fontWeight: 500,
    letterSpacing: "0.16em",
    textTransform: "uppercase",
    color: "var(--ink-muted)",
  },
  path: {
    fontFamily: "var(--font-mono)",
    fontSize: "0.72rem",
    color: "var(--ink-muted)",
  },
  markdown: {
    fontSize: "0.88rem",
    lineHeight: 1.6,
    color: "var(--ink)",
    maxHeight: "24rem",
    overflow: "auto",
  },
  rawMd: {
    fontFamily: "var(--font-mono)",
    fontSize: "0.78rem",
    lineHeight: 1.55,
    whiteSpace: "pre-wrap",
    color: "var(--ink-soft)",
    margin: 0,
    maxHeight: "24rem",
    overflow: "auto",
  },
};
