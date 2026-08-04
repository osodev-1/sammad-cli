import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth/session", () => ({ verifyBearer: vi.fn() }));
vi.mock("@/lib/billing/quota", () => ({ getOrgUsage: vi.fn() }));

import { verifyBearer } from "@/lib/auth/session";
import { getOrgUsage } from "@/lib/billing/quota";
import { computeUsage } from "@/lib/billing/usage";
import { GET } from "@/app/api/v1/usage/route";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-/i;
const SESSION = { sessionId: "sess_1", userId: "user_a", orgId: "org_a" };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/v1/usage — the `sanad usage` read", () => {
  it("returns the CLI's { used, limit, periodEnd, byModel[] } for a valid session bearer", async () => {
    vi.mocked(verifyBearer).mockResolvedValue(SESSION);
    vi.mocked(getOrgUsage).mockResolvedValue({
      plan: "free",
      status: computeUsage({
        requestsUsed: 42,
        requestsLimit: 200,
        tokensUsed: 165_000,
        tokensLimit: 1_000_000,
      }),
      periodStart: new Date("2026-08-01T00:00:00Z"),
      currentPeriodEnd: new Date("2026-09-01T00:00:00Z"),
      hasStripeCustomer: false,
      byModel: [
        { alias: "kimi-k2.7-code", requests: 30, tokensIn: 120_000, tokensOut: 45_000 },
        { alias: "gpt-5.3-codex", requests: 12, tokensIn: 0, tokensOut: 0 },
      ],
    });

    const req = new NextRequest("http://localhost/api/v1/usage", {
      headers: { Authorization: "Bearer sess_valid" },
    });
    const res = await GET(req);

    expect(res.status).toBe(200);
    const body = await res.json();

    // used/limit are REQUEST counts, periodEnd is ISO
    expect(body.data).toMatchObject({
      used: 42,
      limit: 200,
      periodEnd: "2026-09-01T00:00:00.000Z",
    });
    expect(body.data.byModel).toEqual([
      { alias: "kimi-k2.7-code", requests: 30, tokensIn: 120_000, tokensOut: 45_000 },
      { alias: "gpt-5.3-codex", requests: 12, tokensIn: 0, tokensOut: 0 },
    ]);
    expect(body.meta.requestId).toMatch(UUID_RE);
    // camelCase, no snake_case leak
    expect(body.data.byModel[0]).toHaveProperty("tokensIn");
    expect(body.data.byModel[0]).not.toHaveProperty("tokens_in");
    expect(body.error).toBeUndefined();
  });

  it("returns periodEnd null and an empty byModel for a fresh free org", async () => {
    vi.mocked(verifyBearer).mockResolvedValue(SESSION);
    vi.mocked(getOrgUsage).mockResolvedValue({
      plan: "free",
      status: computeUsage({
        requestsUsed: 0,
        requestsLimit: 200,
        tokensUsed: 0,
        tokensLimit: 1_000_000,
      }),
      periodStart: new Date("2026-08-01T00:00:00Z"),
      currentPeriodEnd: null,
      hasStripeCustomer: false,
      byModel: [],
    });

    const body = await (
      await GET(new NextRequest("http://localhost/api/v1/usage"))
    ).json();
    expect(body.data.periodEnd).toBeNull();
    expect(body.data.byModel).toEqual([]);
    expect(body.data.used).toBe(0);
    expect(body.data.limit).toBe(200);
  });

  it("returns 401 for a missing or invalid session bearer", async () => {
    vi.mocked(verifyBearer).mockResolvedValue(null);
    const res = await GET(new NextRequest("http://localhost/api/v1/usage"));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("unauthorized");
    expect(body.data).toBeUndefined();
  });
});
