import type { CheckpointSummary } from "./transcript";

/**
 * Pure, throw-never formatters for the checkpoint footer / dock Checkpoints
 * section (P5 Task 4). Nothing here talks to the network — CheckpointFooter
 * and ContextDock's Checkpoints section are the callers, same "pure display
 * helper" split lib/coder/toolDisplay.ts already established for tool cards.
 */

/** "3 files changed +12 −4" — the per-turn footer's summary line. Singular
 * "file" for exactly one, so a one-file turn doesn't read as a typo. */
export function formatCheckpointSummary(c: CheckpointSummary): string {
  const noun = c.filesChanged === 1 ? "file" : "files";
  return `${c.filesChanged} ${noun} changed +${c.additions} −${c.deletions}`;
}

/** The Revert confirm's warning copy — every clause here is load-bearing:
 * what gets restored, that a safety checkpoint makes the revert itself
 * undoable, that non-agent edits are captured but still removed from the
 * working tree, and the `.sanad` blueprint-rollback caveat. `turnNumber` is
 * a 1-based ordinal among this conversation's checkpointed turns (turnId
 * itself is an opaque id, not something a person can eyeball in a warning). */
export function buildRevertWarning(turnNumber: number): string {
  return (
    `This restores the workspace to before turn ${turnNumber} and discards ` +
    `turn ${turnNumber} and all later turns' file changes. A safety ` +
    `checkpoint is saved first (undoable). Any uncommitted edits made ` +
    `outside the agent are captured in the safety checkpoint but removed ` +
    `from the working tree. Changes under \`.sanad/\` may invalidate a ` +
    `pending blueprint rollback.`
  );
}

/** Whether RevertConfirm's per-turn file list (from `fetchCoderDiff`,
 * that turn's OWN `pre..post`) understates what a revert actually discards
 * (P5 Task 4 review, Important). `fetchCoderDiff` only ever diffs the ONE
 * turn being reverted — that equals the full disk delta to the current
 * worktree ONLY when it's the LATEST checkpointed turn (nothing came after
 * it to also get discarded). For any earlier turn, later turns' changes are
 * discarded by the revert too but never appear in that turn's own diff, so
 * the list alone would be misleading about a destructive action. Frontend-
 * only signal — both `turnNumber` and `totalCheckpoints` are already
 * computed client-side (the footer's ordinal / `coderCheckpoints.length`);
 * no backend change (a true cumulative `pre..worktree` diff for an
 * arbitrary historical turn is a separate, logged follow-up). */
export function revertDiscardsUnlistedChanges(
  turnNumber: number,
  totalCheckpoints: number,
): boolean {
  return turnNumber < totalCheckpoints;
}

/** The caveat line RevertConfirm shows alongside the file list whenever
 * `revertDiscardsUnlistedChanges` is true — kept as a named constant so the
 * component and its test read the same string. */
export const LATER_TURNS_CAVEAT =
  "Later turns' changes will also be discarded but aren't listed below.";
