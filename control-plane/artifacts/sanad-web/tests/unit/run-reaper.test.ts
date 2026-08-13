import { describe, it, expect, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

const updates: any[] = [];
const whereArgs: any[] = [];
const staleRows = [{ id: "r_aaaaaaaaaaaa" }, { id: "r_bbbbbbbbbbbb" }];
// Simulates a race: r_bbbbbbbbbbbb genuinely completed via POST
// .../runs/{id}/complete between the stale-candidate select and the
// guarded UPDATE below, so the status="running" re-check excludes it from
// RETURNING even though it was in the stale-candidate set.
const returningRows = [{ id: "r_aaaaaaaaaaaa" }];

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        leftJoin: vi.fn(() => ({ where: vi.fn(async () => staleRows) })),
        where: vi.fn(async () => staleRows),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn((v: any) => {
        updates.push(v);
        return {
          where: vi.fn((w: any) => {
            whereArgs.push(w);
            return { returning: vi.fn(async () => returningRows) };
          }),
        };
      }),
    })),
  },
}));

import { sweepLostRuns } from "@/lib/runs/reaper";

describe("sweepLostRuns", () => {
  it("marks stale running runs lost via a status-guarded batch update, counting only what RETURNING confirms", async () => {
    const n = await sweepLostRuns(300_000);

    // The guarded UPDATE only actually flipped 1 of the 2 stale candidates
    // (simulated race above) — the returned count must come from
    // RETURNING's length, not the 2-row candidate-select count. This is
    // the regression the guard exists to prevent: silently reporting
    // "reaped" for a run the UPDATE didn't touch.
    expect(n).toBe(1);
    expect(updates).toHaveLength(1); // one batched statement, not one per stale row
    expect(updates[0]).toMatchObject({ status: "lost", errorCode: "machine_lost" });

    // Render the real WHERE condition sweepLostRuns built (drizzle's own
    // PgDialect, not a stand-in) to confirm it re-checks status = "running"
    // in addition to the id list — dropping this guard is exactly what let
    // the reaper clobber a run that completed mid-sweep.
    const { sql, params } = new PgDialect().sqlToQuery(whereArgs[0]);
    expect(sql).toMatch(/"status"\s*=\s*\$\d/);
    expect(params).toContain("running");
    expect(sql).toMatch(/"id"\s+in\s*\(/i);
  });
});
