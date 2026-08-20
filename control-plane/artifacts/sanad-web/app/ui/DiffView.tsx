import type { CSSProperties } from "react";
import { diffHunks } from "@/lib/blueprint/diff";

/**
 * Hunked line diff component — additions bold with "+", removals muted with "−";
 * a too-large or unchanged file falls back to sensible text. Achromatic.
 * Renders "Show full file" button only when onShowFull callback is provided.
 */
export function DiffView({
  before,
  after,
  onShowFull,
}: {
  before: string;
  after: string;
  onShowFull?: () => void;
}) {
  const hunks = diffHunks(before, after);
  if (hunks === null) {
    return <pre style={s.content}>{after}</pre>; // too large to diff exactly
  }
  if (hunks.length === 0) {
    return <span style={s.deleteNote}>No changes to this file.</span>;
  }
  return (
    <div style={s.diffWrap}>
      {hunks.map((h, hi) => (
        <div key={hi}>
          {hi > 0 && <div style={s.hunkGap}>···</div>}
          <div style={s.hunkHeader}>@ line {h.beforeLine}</div>
          {h.lines.map((l, li) => (
            <div
              key={li}
              style={{
                ...s.diffLine,
                ...(l.kind === "add" ? s.diffAdd : null),
                ...(l.kind === "del" ? s.diffDel : null),
              }}
            >
              <span style={s.diffSign}>
                {l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}
              </span>
              {l.text || " "}
            </div>
          ))}
        </div>
      ))}
      {onShowFull && (
        <button style={s.fullToggle} onClick={onShowFull}>
          Show full file
        </button>
      )}
    </div>
  );
}

const s: Record<string, CSSProperties> = {
  diffWrap: {
    display: "flex",
    flexDirection: "column",
    background: "var(--paper-sunken)",
    border: "1px solid var(--rule)",
    borderRadius: "var(--radius-sm)",
    padding: "0.45rem 0.6rem",
    maxHeight: "260px",
    overflowY: "auto",
  },
  diffLine: {
    display: "flex",
    gap: "0.45rem",
    fontFamily: "var(--font-mono)",
    fontSize: "0.72rem",
    lineHeight: 1.5,
    color: "var(--ink-muted)",
    whiteSpace: "pre-wrap",
  },
  /* Weight, not hue: additions read heavy, removals read struck + faint. */
  diffAdd: { color: "var(--ink)", fontWeight: 650 },
  diffDel: { textDecoration: "line-through", opacity: 0.55 },
  diffSign: { width: "1ch", flexShrink: 0, userSelect: "none" },
  hunkHeader: {
    fontFamily: "var(--font-mono)",
    fontSize: "0.62rem",
    letterSpacing: "0.06em",
    color: "var(--ink-muted)",
    margin: "0.2rem 0",
  },
  hunkGap: {
    textAlign: "center",
    color: "var(--ink-muted)",
    fontSize: "0.7rem",
    margin: "0.15rem 0",
  },
  fullToggle: {
    alignSelf: "flex-start",
    marginTop: "0.4rem",
    font: "inherit",
    fontSize: "0.7rem",
    color: "var(--ink-muted)",
    background: "none",
    border: "none",
    textDecoration: "underline",
    textUnderlineOffset: "2px",
    cursor: "pointer",
    padding: 0,
  },
  content: {
    margin: 0,
    padding: "0.6rem 0.75rem",
    background: "var(--paper-sunken)",
    border: "1px solid var(--rule)",
    borderRadius: "var(--radius-sm)",
    fontFamily: "var(--font-mono)",
    fontSize: "0.72rem",
    lineHeight: 1.5,
    color: "var(--ink)",
    whiteSpace: "pre-wrap",
    overflowX: "auto",
    maxHeight: "220px",
  },
  deleteNote: {
    fontSize: "0.72rem",
    fontStyle: "italic",
    color: "var(--ink-muted)",
  },
};
