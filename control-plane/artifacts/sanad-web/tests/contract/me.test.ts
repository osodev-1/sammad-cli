import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth/session", () => ({
  verifyBearer: vi.fn(),
  getSessionMembership: vi.fn(),
}));

import { verifyBearer, getSessionMembership } from "@/lib/auth/session";
import { GET } from "@/app/api/v1/auth/me/route";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-/i;

const SESSION = {
  sessionId: "sess_test_1",
  userId: "user_abc",
  orgId: "org_xyz",
};
const MEMBERSHIP = {
  id: "mem_001",
  orgId: SESSION.orgId,
  userId: SESSION.userId,
  role: "admin",
  seatAssigned: true,
  createdAt: new Date(),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/v1/auth/me", () => {
  it("returns userId, organizationId, membershipId, role, permissions[] for a valid bearer", async () => {
    vi.mocked(verifyBearer).mockResolvedValue(SESSION);
    vi.mocked(getSessionMembership).mockResolvedValue(MEMBERSHIP);

    const req = new NextRequest("http://localhost/api/v1/auth/me", {
      headers: { Authorization: "Bearer tok_valid" },
    });
    const res = await GET(req);

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.data).toMatchObject({
      userId: SESSION.userId,
      organizationId: SESSION.orgId,
      membershipId: MEMBERSHIP.id,
      role: MEMBERSHIP.role,
      permissions: expect.any(Array),
    });
    // permissions must be an array (possibly empty, never absent)
    expect(Array.isArray(body.data.permissions)).toBe(true);
    expect(body.meta.requestId).toMatch(UUID_RE);
    expect(body.error).toBeUndefined();
  });

  it("uses camelCase field names (no snake_case)", async () => {
    vi.mocked(verifyBearer).mockResolvedValue(SESSION);
    vi.mocked(getSessionMembership).mockResolvedValue(MEMBERSHIP);

    const req = new NextRequest("http://localhost/api/v1/auth/me");
    const body = await (await GET(req)).json();

    // Assert camelCase keys are present
    expect(body.data).toHaveProperty("userId");
    expect(body.data).toHaveProperty("organizationId");
    expect(body.data).toHaveProperty("membershipId");
    // Assert snake_case equivalents are absent
    expect(body.data).not.toHaveProperty("user_id");
    expect(body.data).not.toHaveProperty("organization_id");
    expect(body.data).not.toHaveProperty("membership_id");
  });

  it("returns 401 when no bearer token is present", async () => {
    vi.mocked(verifyBearer).mockResolvedValue(null);

    const req = new NextRequest("http://localhost/api/v1/auth/me");
    const res = await GET(req);

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("unauthorized");
    expect(body.error.requestId).toMatch(UUID_RE);
    expect(typeof body.error.message).toBe("string");
    expect(body.data).toBeUndefined();
  });

  it("returns 401 when the membership record is missing", async () => {
    vi.mocked(verifyBearer).mockResolvedValue(SESSION);
    vi.mocked(getSessionMembership).mockResolvedValue(null);

    const req = new NextRequest("http://localhost/api/v1/auth/me");
    const res = await GET(req);

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("unauthorized");
  });
});
