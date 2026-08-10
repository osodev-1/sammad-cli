import { describe, it, expect } from "vitest";
import { fromStored, toStored, type Message } from "@/lib/architect/transcript";
import { architectMessageState } from "@/lib/sessions/state";
import type { ChangePlan } from "@/lib/blueprint/api";

const plan: ChangePlan = {
  summary: "Create Skill “Code Review”",
  operations: [
    {
      op: "create",
      path: ".sanad/skills/code-review/skill.yaml",
      content: "…",
    },
    { op: "create", path: ".sanad/skills/code-review/SKILL.md", content: "…" },
  ],
  preconditions: [
    { path: ".sanad/skills/code-review/skill.yaml", sha256: null },
    { path: ".sanad/skills/code-review/SKILL.md", sha256: null },
  ],
  graphDelta: { nodesAdded: ["skill:code-review"], edgesAdded: [] },
};

describe("architect transcript persistence", () => {
  it("stores a record: pending plans expire, applied plans keep their outcome", () => {
    const live: Message[] = [
      { role: "user", text: "add a code review skill" },
      {
        role: "assistant",
        blocks: [
          { kind: "text", text: "Here's a plan." },
          { kind: "tool", label: "BlueprintGraph" },
          {
            kind: "plan",
            summary: plan.summary,
            files: 2,
            state: "pending",
            plan,
          },
          {
            kind: "plan",
            summary: "Earlier change",
            files: 1,
            state: "applied",
            txId: "tx_9",
          },
        ],
      },
    ];
    const stored = toStored(live);
    // Every stored message validates against the uiState schema.
    for (const m of stored) {
      expect(architectMessageState.safeParse(m).success).toBe(true);
    }
    const blocks = stored[1].role === "assistant" ? stored[1].blocks : [];
    const plans = blocks.filter((b) => b.kind === "plan");
    expect(plans.map((p) => p.kind === "plan" && p.state)).toEqual([
      "expired", // pending never survives a restore as applyable
      "applied",
    ]);
    // The full ChangePlan (file contents) is never persisted.
    expect(JSON.stringify(stored)).not.toContain("operations");
  });

  it("round-trips through fromStored with plans inert", () => {
    const restored = fromStored(
      toStored([
        { role: "user", text: "hi" },
        {
          role: "assistant",
          blocks: [
            { kind: "plan", summary: "S", files: 1, state: "pending", plan },
          ],
        },
      ]),
    );
    const b = restored[1].role === "assistant" ? restored[1].blocks[0] : null;
    expect(b && b.kind === "plan" && b.state).toBe("expired");
    expect(b && b.kind === "plan" && b.plan).toBeUndefined();
  });

  it("caps message count and truncates long text", () => {
    const many: Message[] = Array.from({ length: 80 }, (_, i) => ({
      role: "user" as const,
      text: i === 79 ? "x".repeat(10_000) : `m${i}`,
    }));
    const stored = toStored(many);
    expect(stored).toHaveLength(60);
    const last = stored[stored.length - 1];
    expect(last.role === "user" && last.text.length).toBeLessThanOrEqual(8000);
  });
});
