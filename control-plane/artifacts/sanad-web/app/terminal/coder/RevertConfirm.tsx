"use client";

import type { CSSProperties } from "react";
import { button, disabled, size, state } from "../../ui/theme";
import {
  buildRevertWarning,
  revertDiscardsUnlistedChanges,
  LATER_TURNS_CAVEAT,
} from "@/lib/coder/checkpointDisplay";

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
 *
 * P5 Task 4 review (Important): `fetchCoderDiff` only ever diffs the turn
 * BEING reverted (its own `pre..post`), never the cumulative delta to the
 * current worktree — those coincide only when this IS the latest
 * checkpointed turn. For an earlier turn, a revert also discards every
 * later turn's changes, which never show up in this list — so whenever
 * `totalCheckpoints` says this isn't the latest turn, a caveat line runs
 * alongside the (still shown, still useful) list rather than letting it
 * silently pass as the complete picture of what disappears.
 */
export function RevertConfirm({
  turnNumber,
  totalCheckpoints,
  files,
  filesLoading,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  /** 1-based ordinal among this conversation's checkpointed turns. */
  turnNumber: number;
  /** Total checkpointed turns in this conversation — `turnNumber ===
   * totalCheckpoints` is "this is the latest", the only case where the
   * file list below is the full revert impact. */
  totalCheckpoints: number;
  files: { status: string; path: string }[] | undefined;
  filesLoading: boolean;
  busy: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const incomplete = revertDiscardsUnlistedChanges(turnNumber, totalCheckpoints);
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
        {!filesLoading && incomplete && (
          <span style={s.caveat}>{LATER_TURNS_CAVEAT}</span>
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
  caveat: {
    fontSize: "0.72rem",
    fontWeight: 600,
    color: "var(--ink)",
    fontStyle: "italic",
    marginTop: "0.2rem",
  },
  actions: { display: "flex", gap: "0.5rem" },
};
