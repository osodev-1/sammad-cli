import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth/session", () => ({
  verifyBearer: vi.fn(),
}));

vi.mock("@/lib/tokens/runtime", () => {
  class EntitlementError extends Error {
    constructor(public readonly reason: "no_plan" | "no_seat") {
      super(`Entitlement check failed: ${reason}`);
    }
  }
  return {
    renewRuntime: vi.fn(),
    EntitlementError,
  };
});

import { verifyBearer } from "@/lib/auth/session";
import { renewRuntime, EntitlementError } from "@/lib/tokens/runtime";
import { POST } from "@/app/api/v1/runtime-tokens/renew/route";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-/i;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

const SESSION = {
  sessionId: "sess_test_1",
  userId: "user_abc",
  orgId: "org_xyz",
};

const makeReq = (body?: unknown) =>
  new NextRequest("http://localhost/api/v1/runtime-tokens/renew", {
    method: "POST",
    headers: {
      Authorization: "Bearer tok_valid",
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(verifyBearer).mockResolvedValue(SESSION as never);
});

describe("POST /api/v1/runtime-tokens/renew", () => {
  it("returns 200 with { expiresAt: ISO string } on success", async () => {
    vi.mocked(renewRuntime).mockResolvedValue({
      expiresAt: "2026-08-03T00:10:00.000Z",
    });

    const res = await POST(makeReq({ tokenId: "tok_123" }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({
      expiresAt: expect.stringMatching(ISO_RE),
    });
    expect(body.meta.requestId).toMatch(UUID_RE);
    expect(body.error).toBeUndefined();
    expect(renewRuntime).toHaveBeenCalledWith(SESSION, "tok_123");
  });

  it("returns 400 invalid_request when tokenId is missing", async () => {
    const res = await POST(makeReq({}));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_request");
    expect(renewRuntime).not.toHaveBeenCalled();
  });

  it("returns 400 invalid_request when body is not JSON", async () => {
    const req = new NextRequest(
      "http://localhost/api/v1/runtime-tokens/renew",
      {
        method: "POST",
        headers: { Authorization: "Bearer tok_valid" },
        body: "not-json",
      },
    );
    const res = await POST(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_request");
  });

  it("returns 401 unauthorized for an invalid bearer", async () => {
    vi.mocked(verifyBearer).mockResolvedValue(null as never);

    const res = await POST(makeReq({ tokenId: "tok_123" }));

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("unauthorized");
    expect(renewRuntime).not.toHaveBeenCalled();
  });

  it("returns 410 token_expired for an expired token", async () => {
    vi.mocked(renewRuntime).mockRejectedValue(new Error("token_expired"));

    const res = await POST(makeReq({ tokenId: "tok_old" }));

    expect(res.status).toBe(410);
    const body = await res.json();
    expect(body.error.code).toBe("token_expired");
  });

  it("returns 410 token_expired for an unknown token", async () => {
    vi.mocked(renewRuntime).mockRejectedValue(new Error("token_not_found"));

    const res = await POST(makeReq({ tokenId: "tok_missing" }));

    expect(res.status).toBe(410);
    const body = await res.json();
    expect(body.error.code).toBe("token_expired");
  });

  it("returns 402 subscription_required when the org's plan lapsed", async () => {
    vi.mocked(renewRuntime).mockRejectedValue(new EntitlementError("no_plan"));

    const res = await POST(makeReq({ tokenId: "tok_123" }));

    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error.code).toBe("subscription_required");
  });

  it("returns 403 no_seat when the member's seat was revoked", async () => {
    vi.mocked(renewRuntime).mockRejectedValue(new EntitlementError("no_seat"));

    const res = await POST(makeReq({ tokenId: "tok_123" }));

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("no_seat");
  });

  it("returns 500 retryable when renewRuntime throws unexpectedly", async () => {
    vi.mocked(renewRuntime).mockRejectedValue(new Error("db failure"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await POST(makeReq({ tokenId: "tok_123" }));

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe("internal_error");
    expect(body.error.retryable).toBe(true);
    spy.mockRestore();
  });
});
