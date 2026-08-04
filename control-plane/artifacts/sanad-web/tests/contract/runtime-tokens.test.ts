import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth/session", () => ({
  verifyBearer: vi.fn(),
}));

vi.mock("@/lib/tokens/runtime", () => {
  class EntitlementError extends Error {
    constructor(public readonly reason: "no_plan" | "no_seat") {
      super(`Entitlement check failed: ${reason}`);
      this.name = "EntitlementError";
    }
  }
  return {
    mintRuntime: vi.fn(),
    EntitlementError,
  };
});

import { verifyBearer } from "@/lib/auth/session";
import { mintRuntime, EntitlementError } from "@/lib/tokens/runtime";
import { POST } from "@/app/api/v1/runtime-tokens/route";
import { MODEL_CATALOG, DEFAULT_MODEL_ALIAS } from "@/lib/models/catalog";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-/i;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

const SESSION = {
  sessionId: "sess_test_1",
  userId: "user_abc",
  orgId: "org_xyz",
};

/** Frozen shape — every key the CLI reads. Must not drift. */
const FROZEN_MINT_RESPONSE = {
  token: "rtok_abc123",
  tokenId: "00000000-0000-0000-0000-000000000001",
  familyId: "fam_xyz789",
  expiresAt: "2026-08-03T00:10:00.000Z",
  absoluteExpiresAt: "2026-08-04T00:00:00.000Z",
  gatewayBaseUrl: "https://gateway.sanadcode.com/v1",
  modelSettings: MODEL_CATALOG.map((m) => ({
    name: m.name,
    maxContextSize: m.maxContextSize,
    capabilities: [...m.capabilities],
  })),
  defaultModelAlias: DEFAULT_MODEL_ALIAS,
};

const makeReq = () =>
  new NextRequest("http://localhost/api/v1/runtime-tokens", {
    method: "POST",
    headers: { Authorization: "Bearer tok_valid" },
  });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/v1/runtime-tokens (mint)", () => {
  it("returns the frozen CLI shape — all required keys, no extra keys", async () => {
    vi.mocked(verifyBearer).mockResolvedValue(SESSION);
    vi.mocked(mintRuntime).mockResolvedValue(FROZEN_MINT_RESPONSE);

    const res = await POST(makeReq());

    expect(res.status).toBe(200);
    const { data } = await res.json();

    // ── required keys ──────────────────────────────────────────────────────
    expect(data).toHaveProperty("token");
    expect(data).toHaveProperty("tokenId");
    expect(data).toHaveProperty("familyId");
    expect(data).toHaveProperty("expiresAt");
    expect(data).toHaveProperty("absoluteExpiresAt");
    expect(data).toHaveProperty("gatewayBaseUrl");
    expect(data).toHaveProperty("modelSettings");
    expect(data).toHaveProperty("defaultModelAlias");

    // ── forbidden key — CLI does not expect this field ──────────────────────
    expect(data).not.toHaveProperty("allowedModelAliases");

    // ── type assertions ────────────────────────────────────────────────────
    expect(typeof data.token).toBe("string");
    expect(data.token.length).toBeGreaterThan(0);
    expect(typeof data.tokenId).toBe("string");
    expect(typeof data.familyId).toBe("string");
    expect(data.expiresAt).toMatch(ISO_RE);
    expect(data.absoluteExpiresAt).toMatch(ISO_RE);
    expect(typeof data.gatewayBaseUrl).toBe("string");
    expect(data.gatewayBaseUrl.startsWith("https://")).toBe(true);
    expect(typeof data.defaultModelAlias).toBe("string");
  });

  it("modelSettings is an array of { name, maxContextSize, capabilities[] }", async () => {
    vi.mocked(verifyBearer).mockResolvedValue(SESSION);
    vi.mocked(mintRuntime).mockResolvedValue(FROZEN_MINT_RESPONSE);

    const { data } = await (await POST(makeReq())).json();

    expect(Array.isArray(data.modelSettings)).toBe(true);
    expect(data.modelSettings.length).toBeGreaterThan(0);

    for (const m of data.modelSettings) {
      expect(typeof m.name).toBe("string");
      expect(typeof m.maxContextSize).toBe("number");
      expect(Array.isArray(m.capabilities)).toBe(true);
      // modelSettings entries must NOT contain allowedModelAliases
      expect(m).not.toHaveProperty("allowedModelAliases");
    }
  });

  it("absoluteExpiresAt is later than expiresAt", async () => {
    vi.mocked(verifyBearer).mockResolvedValue(SESSION);
    vi.mocked(mintRuntime).mockResolvedValue(FROZEN_MINT_RESPONSE);

    const { data } = await (await POST(makeReq())).json();

    expect(new Date(data.absoluteExpiresAt).getTime()).toBeGreaterThan(
      new Date(data.expiresAt).getTime(),
    );
  });

  it("returns 401 when no valid bearer is present", async () => {
    vi.mocked(verifyBearer).mockResolvedValue(null);

    const req = new NextRequest("http://localhost/api/v1/runtime-tokens", {
      method: "POST",
    });
    const res = await POST(req);

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("unauthorized");
    expect(body.error.requestId).toMatch(UUID_RE);
    expect(body.error.retryable).toBe(false);
    expect(body.data).toBeUndefined();
  });

  it("returns 402 subscription_required when the org has no active plan", async () => {
    vi.mocked(verifyBearer).mockResolvedValue(SESSION);
    vi.mocked(mintRuntime).mockRejectedValue(new EntitlementError("no_plan"));

    const res = await POST(makeReq());

    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error.code).toBe("subscription_required");
    expect(body.error.retryable).toBe(false);
  });

  it("returns 403 no_seat when the user has no assigned seat", async () => {
    vi.mocked(verifyBearer).mockResolvedValue(SESSION);
    vi.mocked(mintRuntime).mockRejectedValue(new EntitlementError("no_seat"));

    const res = await POST(makeReq());

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("no_seat");
  });

  it("returns 500 internal_error (retryable) on unexpected failures", async () => {
    vi.mocked(verifyBearer).mockResolvedValue(SESSION);
    vi.mocked(mintRuntime).mockRejectedValue(new Error("db connection lost"));

    const res = await POST(makeReq());

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe("internal_error");
    expect(body.error.retryable).toBe(true);
  });
});
