"use client";

import type { CSSProperties } from "react";
import { button, disabled, size, state } from "../../ui/theme";
import { buildRevertWarning } from "@/lib/coder/checkpointDisplay";

/**
 * The revert confirm dialog (P5 Task 4) — inline, not a modal, so it sits
 * right under the checkpoint footer/dock row it was opened from. Lists the
 * files this turn's checkpoint diff touched (from `fetchCoderDiff`'s
 * name-status — the SAME range the footer's Review shows, `pre..post` or
 * `pre..worktree`; CheckpointFooter passes whatever it already fetched, no
 * separate call here) and states the warning verbatim via
 * `buildRevertWarning`. Confirming/cancelling and the actual `revertCoder`
 * call are the caller's job (CheckpointFooter) — this component is display
 * + two buttons, nothing talks to the network directly.
 */
export function RevertConfirm({
  turnNumber,
  files,
  filesLoading,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  /** 1-based ordinal among this conversation's checkpointed turns. */
  turnNumber: number;
  files: { status: string; path: string }[] | undefined;
  filesLoading: boolean;
  busy: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div style={s.wrap}>
      <div style={state.warningPanel}>
        <span>{buildRevertWarning(turnNumber)}</span>
      </div>
      <div style={s.files}>
        {filesLoading ? (
          <span style={s.filesEmpty}>Loading affected files…</span>
        ) : files && files.length > 0 ? (
          files.map((f) => (
            <span key={f.path} style={s.fileRow} title={f.path}>
              <span style={s.fileStatus}>{f.status}</span>
              {f.path}
            </span>
          ))
        ) : (
          <span style={s.filesEmpty}>No file changes recorded for this turn.</span>
        )}
      </div>
      {error && (
        <div style={state.errorPanel}>
          <span>{error}</span>
        </div>
      )}
      <div style={s.actions}>
        <button
          type="button"
          style={{ ...button.dangerConfirm(size.sm), ...disabled(busy) }}
          disabled={busy}
          onClick={onConfirm}
        >
          {busy ? "Reverting…" : "Revert this turn"}
        </button>
        <button
          type="button"
          style={{ ...button.quiet(size.sm), ...disabled(busy) }}
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

const s: Record<string, CSSProperties> = {
  wrap: {
    display: "flex",
    flexDirection: "column",
    gap: "0.5rem",
    padding: "0.5rem 0",
  },
  files: {
    display: "flex",
    flexDirection: "column",
    gap: "0.2rem",
    maxHeight: "8rem",
    overflowY: "auto",
    padding: "0.3rem 0.5rem",
    border: "1px solid var(--rule)",
    borderRadius: "var(--radius-sm)",
    background: "var(--paper-sunken)",
  },
  fileRow: {
    display: "flex",
    gap: "0.4rem",
    fontFamily: "var(--font-mono)",
    fontSize: "0.7rem",
    color: "var(--ink-soft)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  fileStatus: {
    color: "var(--ink-muted)",
    fontWeight: 700,
    width: "1.1em",
    flexShrink: 0,
  },
  filesEmpty: { fontSize: "0.75rem", color: "var(--ink-muted)" },
  actions: { display: "flex", gap: "0.5rem" },
};
