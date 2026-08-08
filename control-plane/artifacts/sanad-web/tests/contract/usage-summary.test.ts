import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@clerk/nextjs/server", () => ({ auth: vi.fn() }));
vi.mock("@/lib/billing/quota", () => ({ getOrgUsage: vi.fn() }));

import { auth } from "@clerk/nextjs/server";
import { getOrgUsage } from "@/lib/billing/quota";
import { computeUsage } from "@/lib/billing/usage";
import { GET } from "@/app/api/usage/summary/route";

const usageFixture = {
  plan: "free",
  status: computeUsage({
    requestsUsed: 10,
    requestsLimit: 500,
    tokensUsed: 2_000,
    tokensLimit: 1_000_000,
  }),
  periodStart: new Date("2026-08-01T00:00:00Z"),
  currentPeriodEnd: new Date("2026-09-01T00:00:00Z"),
  hasStripeCustomer: false,
  byModel: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getOrgUsage).mockResolvedValue(usageFixture);
});

describe("GET /api/usage/summary — the workspace dock feed", () => {
  it("401s when not signed in, without touching the DB", async () => {
    vi.mocked(auth).mockResolvedValue({ userId: null } as never);
    const res = await GET();
    expect(res.status).toBe(401);
    expect(vi.mocked(getOrgUsage)).not.toHaveBeenCalled();
  });

  it("returns the compact summary scoped to the user's personal org", async () => {
    vi.mocked(auth).mockResolvedValue({ userId: "user_x" } as never);
    const res = await GET();
    expect(res.status).toBe(200);
    // Scoped to the personal org, matching the workspace page's plan chip.
    expect(vi.mocked(getOrgUsage)).toHaveBeenCalledWith("personal_user_x");

    const body = await res.json();
    expect(body.data).toMatchObject({
      plan: "free",
      isExceeded: false,
      periodEnd: "2026-09-01T00:00:00.000Z",
    });
    expect(body.data.requests.used).toBe(10);
    expect(body.data.tokens.used).toBe(2_000);
    // Only the compact fields are exposed — no raw byModel/periodStart leakage.
    expect(body.data.byModel).toBeUndefined();
  });
});
