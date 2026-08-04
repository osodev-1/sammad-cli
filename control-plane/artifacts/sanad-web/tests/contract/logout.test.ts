import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth/session", () => ({
  verifyBearer: vi.fn(),
  revokeSession: vi.fn(),
}));

import { verifyBearer, revokeSession } from "@/lib/auth/session";
import { POST } from "@/app/api/v1/auth/logout/route";

const SESSION = {
  sessionId: "sess_test_1",
  userId: "user_abc",
  orgId: "org_xyz",
};

const makeReq = () =>
  new NextRequest("http://localhost/api/v1/auth/logout", {
    method: "POST",
    headers: { Authorization: "Bearer tok_valid" },
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(verifyBearer).mockResolvedValue(SESSION as never);
  vi.mocked(revokeSession).mockResolvedValue(undefined);
});

describe("POST /api/v1/auth/logout", () => {
  it("returns 204 and revokes the session (which cascades to runtime tokens)", async () => {
    const res = await POST(makeReq());

    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(revokeSession).toHaveBeenCalledWith(SESSION.sessionId);
  });

  it("returns 401 unauthorized for an invalid bearer", async () => {
    vi.mocked(verifyBearer).mockResolvedValue(null as never);

    const res = await POST(makeReq());

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("unauthorized");
    expect(revokeSession).not.toHaveBeenCalled();
  });
});
