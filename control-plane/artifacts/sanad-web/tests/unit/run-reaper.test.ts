import { describe, it, expect, vi } from "vitest";

const updates: any[] = [];
const staleRows = [{ id: "r_aaaaaaaaaaaa" }, { id: "r_bbbbbbbbbbbb" }];
vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        leftJoin: vi.fn(() => ({ where: vi.fn(async () => staleRows) })),
        where: vi.fn(async () => staleRows),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn((v: any) => { updates.push(v); return { where: vi.fn(async () => {}) }; }),
    })),
  },
}));

import { sweepLostRuns } from "@/lib/runs/reaper";

describe("sweepLostRuns", () => {
  it("marks stale running runs lost and returns the count", async () => {
    const n = await sweepLostRuns(300_000);
    expect(n).toBe(2);
    expect(updates[0]).toMatchObject({ status: "lost", errorCode: "machine_lost" });
  });
});
