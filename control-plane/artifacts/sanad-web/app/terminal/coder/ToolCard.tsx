"use client";

import { useState } from "react";
import type { CSSProperties } from "react";
import type { CoderBlock } from "@/lib/coder/transcript";
import type {
  BriefDisplayBlock,
  DiffDisplayBlock,
  DisplayBlock,
  TodoDisplayBlock,
} from "@/lib/coder/types";
import { DiffView } from "../../ui/DiffView";

/**
 * Per-tool card registry for the Coder chat's tool-call blocks (P2b Task 3).
 *
 * Dispatches on `block.name`; every renderer is streaming-safe:
 * - `block.result === undefined` means the call is still in flight — the
 *   card shows the label with a subtle (non-alarming) pending affordance.
 *   The SAME state occurs for a rehydrated/restored block (Task 1's
 *   `fromStored` never resurrects `result` — only `label` survives a
 *   restore), so "pending" here reads as "no live result data", not
 *   necessarily "running right now".
 * - `display` is already validated by `normalizeDisplay` (lib/coder/
 *   toolDisplay.ts) before it reaches this component, but every lookup
 *   here still degrades gracefully (optional chaining, `Array.isArray`,
 *   `typeof` guards) rather than assuming shape — a display block of an
 *   unexpected shape must never crash the card.
 * - An empty `display` array degrades to just the label.
 *
 * Achromatic throughout: state is carried by weight/border/strikethrough,
 * never hue, matching RequestCards.tsx and CoderPanel.tsx's local `s`
 * styling idiom (this file is not part of the shared app/ui/theme.ts
 * vocabulary — it hand-rolls its own `const s`, same as CoderPanel).
 */

type ToolBlock = Extract<CoderBlock, { kind: "tool" }>;

interface CardProps {
  block: ToolBlock;
  pending: boolean;
  display: DisplayBlock[];
}

export function ToolCard({
  block,
  onOpenFile,
}: {
  block: ToolBlock;
  onOpenFile?: (path: string) => void;
}) {
  const pending = block.result === undefined;
  const display = block.result?.display ?? [];

  switch (block.name) {
    case "Shell":
      return <ShellCard block={block} pending={pending} display={display} />;
    case "WriteFile":
    case "StrReplaceFile":
      return (
        <FileEditCard
          block={block}
          pending={pending}
          display={display}
          onOpenFile={onOpenFile}
        />
      );
    case "Grep":
    case "Glob":
    case "ReadFile":
      return <CollapsedCard block={block} pending={pending} display={display} />;
    case "SetTodoList":
      return <TodoCard block={block} pending={pending} display={display} />;
    default:
      return <GenericCard block={block} pending={pending} display={display} />;
  }
}

/* ============================================================ Shell === */

function ShellCard({ block, pending, display }: CardProps) {
  const brief = findBrief(display);
  return (
    <div style={s.card}>
      <LabelRow label={block.label} pending={pending} />
      {block.result && (
        <div style={s.statusRow}>
          <span style={block.result.isError ? s.chipFail : s.chipOk}>
            {block.result.isError ? "✗ failed" : "✓ done"}
          </span>
          {brief && <span style={s.brief}>{brief}</span>}
        </div>
      )}
    </div>
  );
}

/* ================================================ WriteFile / StrReplace === */

function FileEditCard({
  block,
  pending,
  display,
  onOpenFile,
}: CardProps & { onOpenFile?: (path: string) => void }) {
  const diff = findDiff(display);
  const path = diff?.path ?? pathFromArgs(block.args) ?? block.label;
  return (
    <div style={s.card}>
      <div style={s.row}>
        <Dot pending={pending} />
        {onOpenFile ? (
          <button type="button" style={s.pathBtn} onClick={() => onOpenFile(path)}>
            {path}
          </button>
        ) : (
          <span style={s.label}>{path}</span>
        )}
      </div>
      {diff && (
        <>
          <DiffView before={diff.old_text} after={diff.new_text} />
          {diff.is_summary && (
            <div style={s.note}>Diff truncated — showing a partial view.</div>
          )}
        </>
      )}
    </div>
  );
}

/* ==================================================== Grep / Glob / Read === */

function CollapsedCard({ block, pending, display }: CardProps) {
  const [expanded, setExpanded] = useState(false);
  const hasResults = display.length > 0;
  return (
    <div style={s.card}>
      <div style={s.row}>
        <Dot pending={pending} />
        {hasResults ? (
          <button
            type="button"
            style={s.expandBtn}
            onClick={() => setExpanded((v) => !v)}
          >
            <span>{block.label}</span>
            <span style={s.expandHint}>{expanded ? "hide" : "show"}</span>
          </button>
        ) : (
          <span style={s.label}>{block.label}</span>
        )}
      </div>
      {hasResults && expanded && <ResultDump display={display} />}
    </div>
  );
}

/* ============================================================= SetTodoList */

function TodoCard({ block, pending, display }: CardProps) {
  const todo = display.find(
    (d): d is TodoDisplayBlock => d.type === "todo" && Array.isArray((d as TodoDisplayBlock).items),
  );
  if (!todo || todo.items.length === 0) {
    return <LabelRow label={block.label} pending={pending} />;
  }
  return (
    <div style={s.card}>
      <LabelRow label={block.label} pending={pending} />
      <ul style={s.todoList}>
        {todo.items.map((item, i) => (
          <li key={i} style={s.todoItem}>
            <span style={s.todoMark}>
              {item.status === "done" ? "✓" : item.status === "in_progress" ? "◐" : "○"}
            </span>
            <span style={item.status === "done" ? s.todoDone : s.todoText}>
              {item.title}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ================================================================ generic */

function GenericCard({ block, pending, display }: CardProps) {
  const hasDisplay = display.length > 0;
  const hasArgs = block.args && Object.keys(block.args).length > 0;
  return (
    <div style={s.card}>
      <LabelRow label={block.label} pending={pending} />
      {hasDisplay ? (
        <ResultDump display={display} />
      ) : hasArgs ? (
        <pre style={s.mono}>{prettyClip(block.args)}</pre>
      ) : null}
    </div>
  );
}

/* ================================================================ shared */

function LabelRow({ label, pending }: { label: string; pending: boolean }) {
  return (
    <div style={s.row}>
      <Dot pending={pending} />
      <span style={s.label}>{label}</span>
    </div>
  );
}

function Dot({ pending }: { pending: boolean }) {
  return <span style={pending ? s.dotPending : s.dot} />;
}

/** Renders any `display` entries a collapsed/generic card decides to show:
 * a `BriefDisplayBlock` prints as a plain note; anything else (including a
 * server-side `UnknownDisplayBlock` we don't have a specialized card for
 * yet) degrades to a pretty-printed, clipped mono dump rather than being
 * silently dropped. */
function ResultDump({ display }: { display: DisplayBlock[] }) {
  return (
    <div style={s.dump}>
      {display.map((d, i) => {
        if (d.type === "brief" && typeof (d as BriefDisplayBlock).text === "string") {
          return (
            <div key={i} style={s.brief}>
              {(d as BriefDisplayBlock).text}
            </div>
          );
        }
        return (
          <pre key={i} style={s.mono}>
            {prettyClip(d)}
          </pre>
        );
      })}
    </div>
  );
}

function findBrief(display: DisplayBlock[]): string | undefined {
  const b = display.find(
    (d): d is BriefDisplayBlock => d.type === "brief" && typeof (d as BriefDisplayBlock).text === "string",
  );
  return b?.text;
}

function findDiff(display: DisplayBlock[]): DiffDisplayBlock | undefined {
  return display.find((d): d is DiffDisplayBlock => {
    if (d.type !== "diff") return false;
    const diff = d as DiffDisplayBlock;
    return typeof diff.path === "string" && typeof diff.old_text === "string" && typeof diff.new_text === "string";
  });
}

function pathFromArgs(args: Record<string, unknown>): string | undefined {
  const p = args?.path;
  return typeof p === "string" && p ? p : undefined;
}

/** Never throws: JSON.stringify can fail on cyclic input (not expected from
 * server-issued JSON, but the card must not crash if it ever happens). */
function prettyClip(value: unknown, max = 500): string {
  let text: string;
  try {
    text = JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const s: Record<string, CSSProperties> = {
  card: {
    display: "flex",
    flexDirection: "column",
    gap: "0.35rem",
  },
  row: {
    display: "flex",
    alignItems: "center",
    gap: "0.4rem",
  },
  label: {
    fontFamily: "var(--font-mono)",
    fontSize: "0.78rem",
    color: "var(--ink-muted)",
  },
  dot: {
    width: "5px",
    height: "5px",
    borderRadius: "50%",
    background: "var(--ink-muted)",
    display: "inline-block",
    flexShrink: 0,
  },
  dotPending: {
    width: "5px",
    height: "5px",
    borderRadius: "50%",
    border: "1px solid var(--ink-muted)",
    background: "transparent",
    display: "inline-block",
    flexShrink: 0,
    opacity: 0.7,
  },
  statusRow: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    flexWrap: "wrap",
  },
  chipOk: {
    fontFamily: "var(--font-mono)",
    fontSize: "0.68rem",
    fontWeight: 600,
    color: "var(--ink)",
    border: "1px solid var(--rule-strong)",
    borderRadius: "var(--radius-pill)",
    padding: "0.1rem 0.55rem",
  },
  chipFail: {
    fontFamily: "var(--font-mono)",
    fontSize: "0.68rem",
    fontWeight: 700,
    color: "var(--paper)",
    background: "var(--ink)",
    border: "1px solid var(--ink)",
    borderRadius: "var(--radius-pill)",
    padding: "0.1rem 0.55rem",
    alignSelf: "flex-start",
  },
  brief: {
    fontSize: "0.76rem",
    color: "var(--ink-soft)",
  },
  pathBtn: {
    font: "inherit",
    fontFamily: "var(--font-mono)",
    fontSize: "0.78rem",
    color: "var(--ink)",
    background: "none",
    border: "none",
    padding: 0,
    textDecoration: "underline",
    textUnderlineOffset: "2px",
    cursor: "pointer",
    textAlign: "left",
  },
  note: {
    fontSize: "0.72rem",
    fontStyle: "italic",
    color: "var(--ink-muted)",
  },
  expandBtn: {
    display: "inline-flex",
    alignItems: "center",
    gap: "0.4rem",
    font: "inherit",
    fontFamily: "var(--font-mono)",
    fontSize: "0.78rem",
    color: "var(--ink-muted)",
    background: "none",
    border: "none",
    padding: 0,
    cursor: "pointer",
    textAlign: "left",
  },
  expandHint: {
    fontSize: "0.66rem",
    color: "var(--ink-muted)",
    textDecoration: "underline",
    textUnderlineOffset: "2px",
  },
  dump: {
    display: "flex",
    flexDirection: "column",
    gap: "0.3rem",
  },
  mono: {
    margin: 0,
    fontFamily: "var(--font-mono)",
    fontSize: "0.72rem",
    lineHeight: 1.5,
    color: "var(--ink-soft)",
    whiteSpace: "pre-wrap",
    background: "var(--paper-sunken)",
    border: "1px solid var(--rule)",
    borderRadius: "var(--radius-sm)",
    padding: "0.45rem 0.6rem",
    maxHeight: "180px",
    overflow: "auto",
  },
  todoList: {
    listStyle: "none",
    margin: 0,
    padding: 0,
    display: "flex",
    flexDirection: "column",
    gap: "0.25rem",
  },
  todoItem: {
    display: "flex",
    alignItems: "flex-start",
    gap: "0.4rem",
    fontSize: "0.8rem",
  },
  todoMark: {
    fontFamily: "var(--font-mono)",
    color: "var(--ink-muted)",
    flexShrink: 0,
  },
  todoText: {
    color: "var(--ink)",
  },
  todoDone: {
    color: "var(--ink-muted)",
    textDecoration: "line-through",
  },
};
