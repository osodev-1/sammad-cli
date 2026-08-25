import { describe, it, expect } from "vitest";
import {
  formatCheckpointSummary,
  buildRevertWarning,
  revertDiscardsUnlistedChanges,
  LATER_TURNS_CAVEAT,
} from "@/lib/coder/checkpointDisplay";

describe("formatCheckpointSummary (P5 Task 4)", () => {
  it("formats a multi-file summary", () => {
    expect(
      formatCheckpointSummary({
        filesChanged: 3,
        additions: 12,
        deletions: 4,
        hasPost: true,
      }),
    ).toBe("3 files changed +12 −4");
  });

  it("singularizes 'file' for exactly one file", () => {
    expect(
      formatCheckpointSummary({
        filesChanged: 1,
        additions: 2,
        deletions: 0,
        hasPost: true,
      }),
    ).toBe("1 file changed +2 −0");
  });

  it("formats a clean, no-op turn as zero across the board", () => {
    expect(
      formatCheckpointSummary({
        filesChanged: 0,
        additions: 0,
        deletions: 0,
        hasPost: true,
      }),
    ).toBe("0 files changed +0 −0");
  });
});

describe("buildRevertWarning (P5 Task 4)", () => {
  it("names the turn being reverted to and the turn being discarded", () => {
    const text = buildRevertWarning(4);
    expect(text).toContain("before turn 4");
    expect(text).toContain("discards turn 4 and all later turns' file changes");
  });

  it("states the safety checkpoint is saved first and is itself undoable", () => {
    const text = buildRevertWarning(1);
    expect(text).toMatch(/safety checkpoint is saved first \(undoable\)/i);
  });

  it("warns that non-agent edits are captured but removed from the working tree", () => {
    const text = buildRevertWarning(1);
    expect(text).toMatch(/uncommitted edits made outside the agent/i);
    expect(text).toMatch(/removed from the working tree/i);
  });

  it("warns that .sanad/ changes may invalidate a pending blueprint rollback", () => {
    const text = buildRevertWarning(1);
    expect(text).toContain(".sanad/");
    expect(text).toMatch(/invalidate a pending blueprint rollback/i);
  });

  it("uses a different turn number each time it's asked to", () => {
    expect(buildRevertWarning(1)).not.toEqual(buildRevertWarning(2));
  });
});

describe("revertDiscardsUnlistedChanges (P5 Task 4 review, Important)", () => {
  it("is false when reverting the LATEST checkpointed turn — its own diff IS the full impact", () => {
    expect(revertDiscardsUnlistedChanges(3, 3)).toBe(false);
  });

  it("is true when reverting an EARLIER turn — later turns' changes are discarded too but not shown", () => {
    expect(revertDiscardsUnlistedChanges(1, 3)).toBe(true);
    expect(revertDiscardsUnlistedChanges(2, 3)).toBe(true);
  });

  it("is false for the only turn in a single-checkpoint conversation", () => {
    expect(revertDiscardsUnlistedChanges(1, 1)).toBe(false);
  });

  it("LATER_TURNS_CAVEAT names later turns' changes as discarded-but-unlisted", () => {
    expect(LATER_TURNS_CAVEAT).toMatch(/later turns/i);
    expect(LATER_TURNS_CAVEAT).toMatch(/discarded/i);
  });
});
