import { describe, it, expect, vi } from "vitest";

const state: { agentRow: any } = { agentRow: { id: "ag_1", status: "active" } };
vi.mock("@/lib/db", () => ({
  db: {
    insert: vi.fn(() => ({ values: vi.fn(async () => {}), onConflictDoNothing: vi.fn() })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(async () => [state.agentRow]) })) })),
    })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(async () => {}) })) })),
  },
}));

import { bundleContentHash, createDeployment, OwnerRequiredError } from "@/lib/agents/registry";

describe("agent registry", () => {
  it("bundle hash is key-order independent", () => {
    expect(bundleContentHash({ b: "2", a: "1" })).toBe(bundleContentHash({ a: "1", b: "2" }));
  });
  it("deploying an orphaned agent throws owner_required", async () => {
    state.agentRow = { id: "ag_1", status: "orphaned" };
    await expect(
      createDeployment({ agentId: "ag_1", versionId: "av_1", env: "dev" })
    ).rejects.toBeInstanceOf(OwnerRequiredError);
  });
});
