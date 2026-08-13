import { describe, it, expect, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

const updates: any[] = [];
const whereArgs: any[] = [];

const NOW = Date.now();
const OLD = new Date(NOW - 400_000); // older than the 300_000ms cutoff below
const FRESH = new Date(NOW); // well within the cutoff

// Three "running" candidates sharing one deployment (so they all resolve to
// the same — stale — machine lastSeenAt below), differing only in
// startedAt:
//  - r_aaaaaaaaaaaa: stale machine + stale startedAt -> reaped
//  - r_bbbbbbbbbbbb: stale machine + stale startedAt -> would-be reaped, but
//    simulates a race (see returningRows below) — the original regression
//    coverage.
//  - r_cccccccccccc: stale machine + FRESH startedAt -> must never even
//    enter the stale-candidate set, regardless of machine staleness
//    (Finding 1c: a recently-started run is never reaped).
const runningRows = [
  { id: "r_aaaaaaaaaaaa", deploymentId: "dp_1", startedAt: OLD },
  { id: "r_bbbbbbbbbbbb", deploymentId: "dp_1", startedAt: OLD },
  { id: "r_cccccccccccc", deploymentId: "dp_1", startedAt: FRESH },
];
const deploymentRows = [{ deploymentId: "dp_1", env: "prod", workspaceId: "ws_1" }];
const machineRows = [{ workspaceId: "ws_1", env: "prod", lastSeenAt: OLD }];
// Simulates a race: r_bbbbbbbbbbbb genuinely completed via POST
// .../runs/{id}/complete between the stale-candidate select and the
// guarded UPDATE below, so the status="running" re-check excludes it from
// RETURNING even though it was in the stale-candidate set.
const returningRows = [{ id: "r_aaaaaaaaaaaa" }];

let selectCall = 0;
vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(() => {
      selectCall += 1;
      const call = selectCall;
      return {
        from: vi.fn(() => ({
          leftJoin: vi.fn(() => ({ where: vi.fn(async () => deploymentRows) })),
          where: vi.fn(async () => (call === 1 ? runningRows : machineRows)),
        })),
      };
    }),
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
    // RETURNING's length, not the candidate-select count. This is the
    // regression the guard exists to prevent: silently reporting "reaped"
    // for a run the UPDATE didn't touch.
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

    // Finding 1c: r_cccccccccccc has a stale machine (same deployment as
    // r_aaaa/r_bbbb) but a FRESH startedAt — it must never enter the
    // candidate id list at all, i.e. never appear in the update's params.
    expect(params).toContain("r_aaaaaaaaaaaa");
    expect(params).toContain("r_bbbbbbbbbbbb");
    expect(params).not.toContain("r_cccccccccccc");
  });
});
