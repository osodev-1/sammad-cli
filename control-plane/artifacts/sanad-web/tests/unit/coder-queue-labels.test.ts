import { describe, expect, it } from "vitest";
import {
  conversationStatusWord,
  conversationSwitcherLabel,
  leaseStatusLabel,
  queueEntryLabel,
  shortConversationId,
} from "@/lib/coder/queueLabels";

describe("shortConversationId", () => {
  it("keeps a short id as-is", () => {
    expect(shortConversationId("c_ab12")).toBe("c_ab12");
  });

  it("trims a long id to its last 8 characters", () => {
    expect(shortConversationId("c_1234567890abcdef")).toBe("90abcdef");
  });
});

describe("queueEntryLabel (P6a Task 4 — the QueueStrip's per-item label)", () => {
  it("waiting_for_lease + blockedBy names the blocking conversation", () => {
    expect(
      queueEntryLabel({ reason: "waiting_for_lease", blockedBy: "c_a1b2c3d4e5f6" }),
    ).toBe("waiting for conversation c3d4e5f6");
  });

  it("waiting_for_lease without blockedBy falls back to a generic label", () => {
    expect(queueEntryLabel({ reason: "waiting_for_lease" })).toBe(
      "waiting for another conversation",
    );
  });

  it("a plain queued item (no reason) keeps today's label", () => {
    expect(queueEntryLabel({})).toBe("queued");
  });

  it("an unrecognized reason falls back to the plain label rather than rendering it verbatim", () => {
    expect(queueEntryLabel({ reason: "something_else", blockedBy: "c_x" })).toBe(
      "queued",
    );
  });
});

describe("leaseStatusLabel (P6a Task 3 — the composer/queue-strip's lease status line)", () => {
  it("returns null when nobody holds the lease", () => {
    expect(leaseStatusLabel({ kind: null, holder: null })).toBeNull();
  });

  it("returns null when the lease reading itself is missing", () => {
    expect(leaseStatusLabel(undefined)).toBeNull();
    expect(leaseStatusLabel(null)).toBeNull();
  });

  it("kind === 'revert' produces a revert message that never contains the raw __revert__ sentinel", () => {
    const label = leaseStatusLabel({ kind: "revert", holder: null });
    expect(label).toContain("revert");
    expect(label).not.toContain("__revert__");
  });

  it("kind === 'conversation' held by someone else names that conversation", () => {
    expect(
      leaseStatusLabel({ kind: "conversation", holder: "c_a1b2c3d4e5f6" }, "c_self"),
    ).toBe("Conversation c3d4e5f6 is running a turn — new turns here will wait.");
  });

  it("kind === 'conversation' held by THIS conversation is not worth repeating", () => {
    expect(
      leaseStatusLabel({ kind: "conversation", holder: "c_self" }, "c_self"),
    ).toBeNull();
  });
});

describe("conversationStatusWord / conversationSwitcherLabel (switcher list formatting)", () => {
  it("a dead runner reads 'stopped' regardless of busy/turn", () => {
    expect(
      conversationStatusWord({ conversationId: "c_1", alive: false, busy: true, turn: { status: "running" } }),
    ).toBe("stopped");
  });

  it("busy (or a running turn) reads 'running'", () => {
    expect(
      conversationStatusWord({ conversationId: "c_1", alive: true, busy: true, turn: null }),
    ).toBe("running");
    expect(
      conversationStatusWord({ conversationId: "c_1", alive: true, busy: false, turn: { status: "running" } }),
    ).toBe("running");
  });

  it("alive, not busy, no running turn reads 'idle'", () => {
    expect(
      conversationStatusWord({ conversationId: "c_1", alive: true, busy: false, turn: { status: "finished" } }),
    ).toBe("idle");
  });

  it("formats the switcher row as '<short id> — <status>'", () => {
    expect(
      conversationSwitcherLabel({
        conversationId: "c_1234567890abcdef",
        alive: true,
        busy: false,
        turn: null,
      }),
    ).toBe("90abcdef — idle");
  });
});
