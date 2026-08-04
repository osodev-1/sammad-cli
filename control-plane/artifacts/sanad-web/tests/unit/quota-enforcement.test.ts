import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  computeUsage,
  computeDimension,
  usageAlert,
  USAGE_THRESHOLDS,
} from "@/lib/billing/usage";
import { resolveQuota, PLAN_QUOTA } from "@/lib/billing/plans";

/* ------------------------------------------------------------------ *
 * Pure metering logic — no database, no mocks.
 * ------------------------------------------------------------------ */

describe("computeDimension", () => {
  it("escalates on allowance remaining, not consumed", () => {
    expect(computeDimension(0, 1000).level).toBe("ok");
    expect(computeDimension(500, 1000).level).toBe("ok");
    // Boundaries are inclusive.
    expect(computeDimension(750, 1000).level).toBe("warning");
    expect(computeDimension(900, 1000).level).toBe("critical");
    expect(computeDimension(1000, 1000).level).toBe("exceeded");
  });

  it("matches the declared threshold constants", () => {
    const limit = 1000;
    expect(
      computeDimension(limit - limit * USAGE_THRESHOLDS.warning, limit).level
    ).toBe("warning");
    expect(
      computeDimension(limit - limit * USAGE_THRESHOLDS.critical, limit).level
    ).toBe("critical");
  });

  it("never reports 100% used while a balance survives", () => {
    // Plain rounding showed "100% used" beside "100 tokens remaining".
    const d = computeDimension(999_900, 1_000_000);
    expect(d.remaining).toBe(100);
    expect(d.usedPct).toBe(99);
    expect(d.remainingPct).toBeGreaterThan(0);
  });

  it("clamps overage rather than reporting a negative balance", () => {
    const d = computeDimension(1_500, 1_000);
    expect(d.remaining).toBe(0);
    expect(d.usedPct).toBe(100);
    expect(d.level).toBe("exceeded");
  });

  it("survives degenerate inputs", () => {
    expect(computeDimension(-5, 1000).used).toBe(0);
    // A zero limit must not divide by zero or report "healthy".
    expect(computeDimension(10, 0).level).toBe("exceeded");
  });
});

describe("computeUsage — two enforced dimensions", () => {
  const base = {
    requestsUsed: 0,
    requestsLimit: 500,
    tokensUsed: 0,
    tokensLimit: 1_000_000,
  };

  it("reports the worse of the two dimensions", () => {
    const u = computeUsage({ ...base, tokensUsed: 950_000 });
    expect(u.requests.level).toBe("ok");
    expect(u.tokens.level).toBe("critical");
    expect(u.level).toBe("critical");
    expect(u.binding).toBe("tokens");
  });

  it("is exceeded when EITHER cap is gone, not only both", () => {
    const outOfRequests = computeUsage({ ...base, requestsUsed: 500 });
    expect(outOfRequests.tokens.level).toBe("ok");
    expect(outOfRequests.isExceeded).toBe(true);
    expect(outOfRequests.binding).toBe("requests");

    const outOfTokens = computeUsage({ ...base, tokensUsed: 1_000_000 });
    expect(outOfTokens.requests.level).toBe("ok");
    expect(outOfTokens.isExceeded).toBe(true);
    expect(outOfTokens.binding).toBe("tokens");
  });

  it("breaks ties toward whichever has proportionally less left", () => {
    const u = computeUsage({
      ...base,
      requestsUsed: 400, // 20% left
      tokensUsed: 880_000, // 12% left
    });
    expect(u.requests.level).toBe("warning");
    expect(u.tokens.level).toBe("warning");
    expect(u.binding).toBe("tokens");
  });

  it("stays healthy when both dimensions have room", () => {
    const u = computeUsage({ ...base, requestsUsed: 10, tokensUsed: 1000 });
    expect(u.level).toBe("ok");
    expect(u.isExceeded).toBe(false);
    expect(usageAlert(u)).toBeNull();
  });

  it("writes alert copy about the binding dimension", () => {
    const u = computeUsage({ ...base, requestsUsed: 480 });
    expect(usageAlert(u)?.title).toContain("requests");
  });
});

describe("resolveQuota", () => {
  it("falls back to the plan default when there is no override", () => {
    expect(resolveQuota("pro", null)).toEqual(PLAN_QUOTA.pro);
    expect(resolveQuota("nonsense", null)).toEqual(PLAN_QUOTA.free);
  });

  it("honours a genuine override", () => {
    expect(
      resolveQuota("free", { requestsPerMonth: 9999, tokensPerMonth: 5 })
    ).toEqual({ requestsPerMonth: 9999, tokensPerMonth: 5 });
  });

  it("ignores junk per-field rather than locking the org out", () => {
    expect(
      resolveQuota("free", { requestsPerMonth: 0, tokensPerMonth: "lots" })
    ).toEqual(PLAN_QUOTA.free);
  });

  it("keeps a valid field when its sibling is junk", () => {
    const q = resolveQuota("free", { requestsPerMonth: 42, tokensPerMonth: -1 });
    expect(q.requestsPerMonth).toBe(42);
    expect(q.tokensPerMonth).toBe(PLAN_QUOTA.free.tokensPerMonth);
  });
});

/* ------------------------------------------------------------------ *
 * The gate: an exhausted org must not be able to obtain gateway access.
 *
 * Mocked at the database layer rather than by stubbing getOrgUsage, so the
 * real aggregation, quota resolution and threshold logic all run. (Stubbing
 * the export does nothing anyway — assertWithinQuota calls getOrgUsage inside
 * its own module, which never goes through the mock.)
 * ------------------------------------------------------------------ */

const rows = vi.hoisted(() => ({
  /** Result of the subscription lookup (the `.limit()` branch). */
  subscription: [] as unknown[],
  /** Result of the usage aggregate (the `.groupBy()` branch). */
  usage: [] as unknown[],
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => rows.subscription),
          groupBy: vi.fn(async () => rows.usage),
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({ where: vi.fn(async () => undefined) })),
    })),
    insert: vi.fn(() => ({ values: vi.fn(async () => undefined) })),
  },
}));

vi.mock("@/lib/auth/entitlement", () => ({ requireEntitled: vi.fn() }));

import { assertWithinQuota, QuotaExceededError } from "@/lib/billing/quota";
import { requireEntitled } from "@/lib/auth/entitlement";
import { mintRuntime } from "@/lib/tokens/runtime";

const SESSION = { sessionId: "sess_1", userId: "u1", orgId: "o1" };

/** One aggregate row as the grouped query would return it. */
const usageRow = (requests: number, tokensIn: number, tokensOut = 0) => ({
  modelAlias: "sanad-fast",
  requests,
  tokensIn,
  tokensOut,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireEntitled).mockResolvedValue({ ok: true });
  // Free plan: 500 requests, 1M tokens.
  rows.subscription = [
    {
      plan: "free",
      quota: null,
      currentPeriodEnd: null,
      stripeCustomerId: null,
    },
  ];
  rows.usage = [];
});

describe("assertWithinQuota", () => {
  it("passes an org with allowance left", async () => {
    rows.usage = [usageRow(10, 5_000)];
    await expect(assertWithinQuota("o1")).resolves.toBeUndefined();
  });

  it("passes an org that has used nothing", async () => {
    await expect(assertWithinQuota("o1")).resolves.toBeUndefined();
  });

  it("blocks when requests are exhausted even though tokens remain", async () => {
    rows.usage = [usageRow(500, 1_000)];
    await expect(assertWithinQuota("o1")).rejects.toBeInstanceOf(
      QuotaExceededError
    );
    await expect(assertWithinQuota("o1")).rejects.toMatchObject({
      dimension: "requests",
    });
  });

  it("blocks when tokens are exhausted even though requests remain", async () => {
    rows.usage = [usageRow(3, 600_000, 400_000)];
    await expect(assertWithinQuota("o1")).rejects.toMatchObject({
      dimension: "tokens",
    });
  });

  it("sums usage across models, not just the busiest one", async () => {
    // Neither model alone exhausts the cap; together they do.
    rows.usage = [
      { modelAlias: "a", requests: 300, tokensIn: 0, tokensOut: 0 },
      { modelAlias: "b", requests: 200, tokensIn: 0, tokensOut: 0 },
    ];
    await expect(assertWithinQuota("o1")).rejects.toBeInstanceOf(
      QuotaExceededError
    );
  });

  it("honours a negotiated quota override", async () => {
    rows.subscription = [
      {
        plan: "free",
        quota: { requestsPerMonth: 10_000, tokensPerMonth: 50_000_000 },
        currentPeriodEnd: null,
        stripeCustomerId: null,
      },
    ];
    rows.usage = [usageRow(500, 1_000_000)];
    // Would be exhausted on the stock free tier; the override keeps it alive.
    await expect(assertWithinQuota("o1")).resolves.toBeUndefined();
  });
});

describe("mintRuntime quota gate", () => {
  it("issues a token while the org is within quota", async () => {
    rows.usage = [usageRow(1, 100)];
    const result = await mintRuntime(SESSION);
    expect(result.token).toMatch(/^rtok/);
  });

  it("refuses to mint once the allowance is gone", async () => {
    rows.usage = [usageRow(500, 0)];
    await expect(mintRuntime(SESSION)).rejects.toBeInstanceOf(
      QuotaExceededError
    );
  });

  it("checks entitlement before quota — a lapsed plan is the better error", async () => {
    vi.mocked(requireEntitled).mockResolvedValue({
      ok: false,
      reason: "no_plan",
    });
    rows.usage = [usageRow(500, 0)];
    await expect(mintRuntime(SESSION)).rejects.toMatchObject({
      reason: "no_plan",
    });
  });
});
