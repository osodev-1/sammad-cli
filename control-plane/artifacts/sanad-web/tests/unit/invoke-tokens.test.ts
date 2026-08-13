import { describe, it, expect, vi, beforeEach } from "vitest";

const inserted: any[] = [];
const selectResult: { rows: any[] } = { rows: [] };
vi.mock("@/lib/db", () => ({
  db: {
    insert: vi.fn(() => ({ values: vi.fn(async (v: any) => { inserted.push(v); }) })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(async () => selectResult.rows) })) })),
    })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(async () => {}) })) })),
  },
}));
vi.mock("@/lib/auth/entitlement", () => ({ requireEntitled: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/billing/quota", () => ({ assertWithinQuota: vi.fn(async () => {}) }));

import { mintInvoke, verifyInvokeBearer } from "@/lib/tokens/invoke";
import { hashToken } from "@/lib/auth/tokens";

beforeEach(() => { inserted.length = 0; selectResult.rows = []; });

describe("invoke tokens", () => {
  it("mints an itok_ token hashed at rest, scoped to agent+env", async () => {
    const out = await mintInvoke({ userId: "u1", orgId: "o1" }, "ag_1", "prod");
    expect(out.token.startsWith("itok_")).toBe(true);
    expect(inserted[0].tokenHash).toBe(hashToken(out.token));
    expect(inserted[0].agentId).toBe("ag_1");
    expect(inserted[0].env).toBe("prod");
  });
  it("verify returns null without a bearer", async () => {
    const req = new Request("https://x.test/", { headers: {} });
    expect(await verifyInvokeBearer(req)).toBeNull();
  });
  it("verify resolves a live token row", async () => {
    selectResult.rows = [{
      id: "tid", agentId: "ag_1", env: "prod", orgId: "o1",
      expiresAt: new Date(Date.now() + 60_000), revokedAt: null,
    }];
    const req = new Request("https://x.test/", { headers: { authorization: "Bearer itok_abc" } });
    expect(await verifyInvokeBearer(req)).toEqual({
      tokenId: "tid", agentId: "ag_1", env: "prod", orgId: "o1",
    });
  });
});
