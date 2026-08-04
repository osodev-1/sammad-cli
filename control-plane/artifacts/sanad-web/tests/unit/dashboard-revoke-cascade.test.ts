import { describe, it, expect, vi, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { NextRequest } from "next/server";

const authMock = vi.fn();
vi.mock("@clerk/nextjs/server", () => ({
  auth: () => authMock(),
}));

const selectWhere = vi.fn();
const selectLimit = vi.fn();
vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: selectWhere.mockImplementation(() => ({ limit: selectLimit })),
      })),
    })),
    update: vi.fn(),
    insert: vi.fn(),
  },
}));

const revokeSessionMock = vi.fn();
vi.mock("@/lib/auth/session", () => ({
  revokeSession: (...args: unknown[]) => revokeSessionMock(...args),
}));

import { cliSessions } from "@/lib/db/schema";
import { POST } from "@/app/api/dashboard/sessions/[sessionId]/revoke/route";

function makeRequest(sessionId: string) {
  const req = new NextRequest("http://localhost/api/dashboard/sessions/x/revoke", {
    method: "POST",
  });
  return POST(req, { params: Promise.resolve({ sessionId }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ userId: "user_1" });
  selectLimit.mockResolvedValue([{ id: "sess_1" }]);
  revokeSessionMock.mockResolvedValue(undefined);
});

describe("dashboard session revoke route", () => {
  it("returns 401 when unauthenticated and does not revoke", async () => {
    authMock.mockResolvedValue({ userId: null });
    const res = await makeRequest("sess_1");
    expect(res.status).toBe(401);
    expect(revokeSessionMock).not.toHaveBeenCalled();
  });

  it("returns 404 for sessions not owned by the user and does not revoke", async () => {
    selectLimit.mockResolvedValue([]);
    const res = await makeRequest("sess_other");
    expect(res.status).toBe(404);
    expect(revokeSessionMock).not.toHaveBeenCalled();
  });

  it("verifies ownership then cascades revocation through revokeSession", async () => {
    const res = await makeRequest("sess_1");
    expect(res.status).toBe(204);

    // Ownership check scopes the lookup by session id AND user id.
    const cond = selectWhere.mock.calls[0][0];
    expect(cond).toStrictEqual(
      and(eq(cliSessions.id, "sess_1"), eq(cliSessions.userId, "user_1"))
    );

    // Uses the shared helper so runtime tokens are revoked too.
    expect(revokeSessionMock).toHaveBeenCalledTimes(1);
    expect(revokeSessionMock).toHaveBeenCalledWith("sess_1");
  });
});
