import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

const sets: any[] = [];
const wheres: any[] = [];

vi.mock("@/lib/db", () => ({
  db: {
    update: vi.fn(() => ({
      set: vi.fn((v: any) => {
        sets.push(v);
        return {
          where: vi.fn(async (w: any) => {
            wheres.push(w);
          }),
        };
      }),
    })),
  },
}));

import { markRunRunning, markRunFailed } from "@/lib/runs/store";

beforeEach(() => {
  sets.length = 0;
  wheres.length = 0;
});

describe("markRunRunning (Finding 4)", () => {
  it("guards the transition to only match a queued row", async () => {
    await markRunRunning("r_1");

    expect(sets[0]).toMatchObject({ status: "running" });

    // A fast completion POST (or the reaper) landing before this UPDATE
    // must not resurrect an already-terminal row — the WHERE has to carry
    // BOTH id and status="queued", not just id.
    const { sql, params } = new PgDialect().sqlToQuery(wheres[0]);
    expect(sql).toMatch(/"id"\s*=\s*\$\d/);
    expect(sql).toMatch(/"status"\s*=\s*\$\d/);
    expect(params).toContain("r_1");
    expect(params).toContain("queued");
  });
});

describe("markRunFailed (Finding 2)", () => {
  it("nulls the idempotency key when clearIdempotencyKey is set (infra failure)", async () => {
    await markRunFailed("r_1", "wake_timeout", { clearIdempotencyKey: true });

    expect(sets[0]).toMatchObject({
      status: "failed",
      errorCode: "wake_timeout",
      idempotencyKey: null,
    });
  });

  it("nulls the idempotency key for machine_error too", async () => {
    await markRunFailed("r_1", "machine_error", { clearIdempotencyKey: true });

    expect(sets[0]).toMatchObject({
      status: "failed",
      errorCode: "machine_error",
      idempotencyKey: null,
    });
  });

  it("preserves the idempotency key for a genuine run failure (no opts)", async () => {
    await markRunFailed("r_1", "no_output");

    expect(sets[0]).toMatchObject({ status: "failed", errorCode: "no_output" });
    expect(sets[0]).not.toHaveProperty("idempotencyKey");
  });

  it("preserves the idempotency key when clearIdempotencyKey is explicitly false", async () => {
    await markRunFailed("r_1", "turn_budget_exceeded", { clearIdempotencyKey: false });

    expect(sets[0]).not.toHaveProperty("idempotencyKey");
  });
});
