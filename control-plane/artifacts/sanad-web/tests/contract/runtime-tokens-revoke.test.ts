import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth/session", () => ({
  verifyBearer: vi.fn(),
}));

vi.mock("@/lib/tokens/runtime", () => ({
  revokeFamily: vi.fn(),
}));

import { verifyBearer } from "@/lib/auth/session";
import { revokeFamily } from "@/lib/tokens/runtime";
import { POST } from "@/app/api/v1/runtime-tokens/revoke/route";

const SESSION = {
  sessionId: "sess_test_1",
  userId: "user_abc",
  orgId: "org_xyz",
};

const makeReq = (body?: unknown) =>
  new NextRequest("http://localhost/api/v1/runtime-tokens/revoke", {
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

describe("POST /api/v1/runtime-tokens/revoke", () => {
  it("returns 204 with an empty body on success", async () => {
    vi.mocked(revokeFamily).mockResolvedValue(undefined);

    const res = await POST(makeReq({ familyId: "fam_123" }));

    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(revokeFamily).toHaveBeenCalledWith(SESSION, "fam_123");
  });

  it("returns 400 invalid_request when familyId is missing", async () => {
    const res = await POST(makeReq({}));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_request");
    expect(revokeFamily).not.toHaveBeenCalled();
  });

  it("returns 400 invalid_request when body is not JSON", async () => {
    const req = new NextRequest(
      "http://localhost/api/v1/runtime-tokens/revoke",
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

    const res = await POST(makeReq({ familyId: "fam_123" }));

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("unauthorized");
    expect(revokeFamily).not.toHaveBeenCalled();
  });
});
