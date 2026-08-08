import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => {
  const onConflictDoNothing = vi.fn(async () => undefined);
  // Row type is declared so mock.calls is introspectable below.
  const values = vi.fn((_row: Record<string, unknown>) => ({
    onConflictDoNothing,
  }));
  return { onConflictDoNothing, values };
});

vi.mock("@/lib/db", () => ({
  db: { insert: vi.fn(() => ({ values: mocks.values })) },
}));

vi.mock("@/lib/tokens/runtime", () => ({ verifyRuntimeBearer: vi.fn() }));
vi.mock("@/lib/billing/quota", () => ({ getOrgUsage: vi.fn() }));

import { verifyRuntimeBearer } from "@/lib/tokens/runtime";
import { getOrgUsage } from "@/lib/billing/quota";
import { computeUsage } from "@/lib/billing/usage";
import { POST } from "@/app/api/v1/usage/route";

const RUNTIME = {
  tokenId: "tok_1",
  cliSessionId: "sess_1",
  userId: "user_a",
  orgId: "org_a",
  projectId: "project:hh",
};

const statusFor = (requestsUsed: number, tokensUsed: number) =>
  computeUsage({
    requestsUsed,
    requestsLimit: 500,
    tokensUsed,
    tokensLimit: 1_000_000,
  });

const makeReq = (body: unknown) =>
  new NextRequest("http://localhost/api/v1/usage", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: "Bearer rtok_valid",
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const VALID = { modelAlias: "sanad-fast", tokensIn: 100, tokensOut: 50 };

/** The single row handed to drizzle's .values(). */
const inserted = (): Record<string, unknown> => {
  const row = mocks.values.mock.calls[0]?.[0];
  if (!row) throw new Error("expected a usage row to have been inserted");
  return row;
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(verifyRuntimeBearer).mockResolvedValue(RUNTIME);
  vi.mocked(getOrgUsage).mockResolvedValue({
    plan: "free",
    status: statusFor(1, 150),
    periodStart: new Date("2026-08-01T00:00:00Z"),
    currentPeriodEnd: null,
    hasStripeCustomer: false,
    byModel: [],
  });
});

describe("POST /api/v1/usage — auth", () => {
  it("rejects an unrecognised runtime token", async () => {
    vi.mocked(verifyRuntimeBearer).mockResolvedValue(null);
    const res = await POST(makeReq(VALID));
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("unauthorized");
  });

  it("does not write anything when auth fails", async () => {
    vi.mocked(verifyRuntimeBearer).mockResolvedValue(null);
    await POST(makeReq(VALID));
    expect(mocks.values).not.toHaveBeenCalled();
  });
});

describe("POST /api/v1/usage — validation", () => {
  it("rejects a non-JSON body", async () => {
    const res = await POST(makeReq("definitely not json"));
    expect(res.status).toBe(400);
  });

  it("rejects negative token counts", async () => {
    const res = await POST(makeReq({ ...VALID, tokensIn: -1 }));
    expect(res.status).toBe(400);
  });

  it("rejects a missing model alias", async () => {
    const res = await POST(makeReq({ tokensIn: 1, tokensOut: 1 }));
    expect(res.status).toBe(400);
  });
});

describe("POST /api/v1/usage — attribution", () => {
  it("records the event against the token's org and user", async () => {
    const res = await POST(makeReq(VALID));
    expect(res.status).toBe(200);
    expect(inserted()).toMatchObject({
      orgId: "org_a",
      userId: "user_a",
      cliSessionId: "sess_1",
      modelAlias: "sanad-fast",
      tokensIn: 100,
      tokensOut: 50,
    });
  });

  it("ignores org/user supplied in the body — the token is the only authority", async () => {
    await POST(
      makeReq({ ...VALID, orgId: "org_victim", userId: "user_victim" })
    );
    expect(inserted().orgId).toBe("org_a");
    expect(inserted().userId).toBe("user_a");
  });

  it("attributes the event to the token's workspace project", async () => {
    await POST(makeReq(VALID));
    expect(inserted().projectId).toBe("project:hh");
  });

  it("leaves projectId null for a non-workspace (device-flow) token", async () => {
    vi.mocked(verifyRuntimeBearer).mockResolvedValue({
      ...RUNTIME,
      projectId: null,
    });
    await POST(makeReq(VALID));
    expect(inserted().projectId).toBeNull();
  });

  it("defaults cost to zero when the gateway does not price the call", async () => {
    await POST(makeReq(VALID));
    expect(inserted().cost).toBe(0);
  });
});

describe("POST /api/v1/usage — idempotency", () => {
  it("derives a stable id from the caller's eventId", async () => {
    await POST(makeReq({ ...VALID, eventId: "abc" }));
    const first = inserted().id;

    vi.clearAllMocks();
    vi.mocked(verifyRuntimeBearer).mockResolvedValue(RUNTIME);
    vi.mocked(getOrgUsage).mockResolvedValue({
      plan: "free",
      status: statusFor(1, 150),
      periodStart: new Date("2026-08-01T00:00:00Z"),
      currentPeriodEnd: null,
      hasStripeCustomer: false,
      byModel: [],
    });

    await POST(makeReq({ ...VALID, eventId: "abc" }));
    expect(inserted().id).toBe(first);
  });

  it("scopes the idempotency key per org so tenants cannot collide", async () => {
    // usage_events.id is a global PK. If two orgs both send eventId "1" and the
    // key were stored bare, onConflictDoNothing would silently DISCARD the
    // second org's event and under-bill them.
    await POST(makeReq({ ...VALID, eventId: "1" }));
    const orgA = inserted().id;

    vi.clearAllMocks();
    vi.mocked(verifyRuntimeBearer).mockResolvedValue({
      ...RUNTIME,
      orgId: "org_b",
      userId: "user_b",
    });
    vi.mocked(getOrgUsage).mockResolvedValue({
      plan: "free",
      status: statusFor(1, 150),
      periodStart: new Date("2026-08-01T00:00:00Z"),
      currentPeriodEnd: null,
      hasStripeCustomer: false,
      byModel: [],
    });

    await POST(makeReq({ ...VALID, eventId: "1" }));
    expect(inserted().id).not.toBe(orgA);
  });

  it("generates an id when the caller supplies none", async () => {
    await POST(makeReq(VALID));
    expect(typeof inserted().id).toBe("string");
    expect((inserted().id as string).length).toBeGreaterThan(0);
  });
});

describe("POST /api/v1/usage — overage", () => {
  it("still records usage after the allowance is gone", async () => {
    // Enforcement belongs at token issuance; refusing ingest here would freeze
    // the meter at the cap and lose the record of what was actually consumed.
    vi.mocked(getOrgUsage).mockResolvedValue({
      plan: "free",
      status: statusFor(500, 1_000_000),
      periodStart: new Date("2026-08-01T00:00:00Z"),
      currentPeriodEnd: null,
      hasStripeCustomer: false,
      byModel: [],
    });

    const res = await POST(makeReq(VALID));
    expect(res.status).toBe(200);
    expect(mocks.values).toHaveBeenCalled();

    const body = await res.json();
    expect(body.data.exceeded).toBe(true);
    expect(body.data.tokens.remaining).toBe(0);
  });
});
