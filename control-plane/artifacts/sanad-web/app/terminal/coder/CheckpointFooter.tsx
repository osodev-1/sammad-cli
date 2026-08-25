"use client";

import { useState } from "react";
import type { CSSProperties } from "react";
import { fetchCoderDiff, hasFreshDiff, revertCoder, type CoderDiffResult } from "@/lib/coder/client";
import { formatCheckpointSummary } from "@/lib/coder/checkpointDisplay";
import type { CheckpointSummary } from "@/lib/coder/transcript";
import { button, size } from "../../ui/theme";
import { RevertConfirm } from "./RevertConfirm";

/**
 * Per-turn checkpoint footer (P5 Task 4): "<N> files changed +<a> −<d> ·
 * Review · Revert", rendered wherever a turn has a `checkpoint` summary —
 * under its assistant message in the transcript (CoderPanel), and again,
 * unadorned, as a dock Checkpoints row (ContextDock) — same component both
 * places, so Review/Revert behave identically wherever they're triggered
 * from.
 *
 * Review toggles an inline diff fetched on demand (`fetchCoderDiff`),
 * rendered as raw patch TEXT in a `<pre>` — the SAME treatment
 * ContextDock's History commit expansion already uses for `/api/git/show`,
 * deliberately NOT `DiffView` (which wants old/new file CONTENT, the wrong
 * shape for a git patch string). Revert opens `RevertConfirm`, reusing
 * whatever name-status Review already fetched (or fetching it fresh if
 * Revert is clicked first) so the confirm dialog never double-fetches.
 *
 * Checkpoints/revert are human-only UI actions — this component only ever
 * calls `fetchCoderDiff`/`revertCoder` in response to a click; nothing here
 * runs on a timer or on mount.
 */
export function CheckpointFooter({
  cid,
  sessionId,
  turnId,
  turnNumber,
  totalCheckpoints,
  checkpoint,
  onReverted,
}: {
  cid: string;
  sessionId?: string;
  turnId: string;
  /** 1-based ordinal among this conversation's checkpointed turns — human-
   * readable turn identity for the confirm dialog's warning text. */
  turnNumber: number;
  /** Total checkpointed turns in this conversation — lets RevertConfirm
   * tell whether `turnNumber` is the LATEST turn (its own diff is the full
   * revert impact) or an earlier one (later turns' changes are discarded
   * too but not reflected in the file list — P5 Task 4 review). */
  totalCheckpoints: number;
  checkpoint: CheckpointSummary;
  /** Revert only ever touches the workspace tree — never this turn's own
   * machine — so the caller (CoderPanel/SessionWorkspace) is responsible
   * for refreshing whatever else reads that tree (the file browser, the
   * dock's trust/history feed) once this fires. */
  onReverted?: (safetyCheckpoint: string | undefined) => void;
}) {
  const [reviewOpen, setReviewOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [diff, setDiff] = useState<CoderDiffResult | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [revertBusy, setRevertBusy] = useState(false);
  const [revertError, setRevertError] = useState<string | null>(null);
  const [revertedSha, setRevertedSha] = useState<string | null>(null);

  const ensureDiff = () => {
    // Gate on `hasFreshDiff(diff)`, not just `diff !== null` (final-review
    // fix): `fetchCoderDiff` never throws — a transient failure resolves to
    // a non-null `{ok:false,code}`, which used to satisfy this guard just
    // as well as a real success and permanently stick the footer on
    // "(could not load the diff)" with no way to retry.
    if (hasFreshDiff(diff) || diffLoading) return;
    setDiffLoading(true);
    void fetchCoderDiff(cid, turnId, undefined, sessionId).then((res) => {
      setDiffLoading(false);
      setDiff(res);
    });
  };

  const toggleReview = () => {
    setReviewOpen((v) => !v);
    ensureDiff();
  };

  const openConfirm = () => {
    setConfirmOpen(true);
    setRevertError(null);
    ensureDiff();
  };

  const doRevert = () => {
    setRevertBusy(true);
    setRevertError(null);
    void revertCoder(cid, turnId, sessionId).then((res) => {
      setRevertBusy(false);
      if (res.ok) {
        setConfirmOpen(false);
        setRevertedSha(res.safetyCheckpoint ?? "");
        onReverted?.(res.safetyCheckpoint);
        return;
      }
      setRevertError(
        res.code === "workspace_busy"
          ? "Can't revert while a turn is running."
          : (res.message ?? "Could not revert — try again."),
      );
    });
  };

  if (revertedSha !== null) {
    return (
      <div style={s.row}>
        <span style={s.revertedNote}>
          {revertedSha
            ? `Reverted — safety checkpoint ${revertedSha.slice(0, 8)}.`
            : "Reverted."}
        </span>
      </div>
    );
  }

  return (
    <div style={s.wrap}>
      <div style={s.row}>
        <span style={s.summary}>{formatCheckpointSummary(checkpoint)}</span>
        <button type="button" style={button.quiet(size.sm)} onClick={toggleReview}>
          {reviewOpen ? "Hide diff" : "Review"}
        </button>
        <button type="button" style={button.quiet(size.sm)} onClick={openConfirm}>
          Revert
        </button>
      </div>

      {reviewOpen && (
        <pre style={s.diff}>
          {diffLoading
            ? "Loading…"
            : diff?.ok
              ? diff.patch || "(no changes)"
              : "(could not load the diff)"}
        </pre>
      )}

      {confirmOpen && (
        <RevertConfirm
          turnNumber={turnNumber}
          totalCheckpoints={totalCheckpoints}
          files={diff?.ok ? diff.nameStatus : undefined}
          filesLoading={diffLoading}
          busy={revertBusy}
          error={revertError}
          onConfirm={doRevert}
          onCancel={() => setConfirmOpen(false)}
        />
      )}
    </div>
  );
}

const s: Record<string, CSSProperties> = {
  wrap: {
    display: "flex",
    flexDirection: "column",
    gap: "0.3rem",
    marginTop: "0.15rem",
  },
  row: {
    display: "flex",
    alignItems: "center",
    gap: "0.6rem",
    flexWrap: "wrap",
  },
  summary: {
    fontFamily: "var(--font-mono)",
    fontSize: "0.7rem",
    color: "var(--ink-muted)",
  },
  revertedNote: {
    fontFamily: "var(--font-mono)",
    fontSize: "0.7rem",
    color: "var(--ink-muted)",
    fontStyle: "italic",
  },
  diff: {
    margin: 0,
    padding: "0.4rem 0.5rem",
    background: "var(--paper-sunken)",
    border: "1px solid var(--rule)",
    borderRadius: "var(--radius-sm)",
    fontFamily: "var(--font-mono)",
    fontSize: "0.62rem",
    lineHeight: 1.45,
    color: "var(--ink-soft)",
    whiteSpace: "pre-wrap",
    overflowX: "auto",
    maxHeight: "220px",
    overflowY: "auto",
  },
};
