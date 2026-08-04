import { describe, it, expect, vi, beforeEach } from "vitest";
import { and, eq, isNull } from "drizzle-orm";

const authMock = vi.fn();
vi.mock("@clerk/nextjs/server", () => ({
  auth: () => authMock(),
}));

let orgRows: { orgId: string }[] = [];
const selectDistinctWhere = vi.fn(async (..._args: unknown[]) => orgRows);
vi.mock("@/lib/db", () => ({
  db: {
    selectDistinct: vi.fn(() => ({
      from: vi.fn(() => ({
        where: selectDistinctWhere,
      })),
    })),
    select: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
  },
}));

const revokeSessionsForMemberMock = vi.fn();
vi.mock("@/lib/auth/session", () => ({
  revokeSessionsForMember: (...args: unknown[]) =>
    revokeSessionsForMemberMock(...args),
}));

import { cliSessions } from "@/lib/db/schema";
import { POST } from "@/app/api/dashboard/sessions/revoke-all/route";

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ userId: "user_1" });
  orgRows = [{ orgId: "personal_user_1" }];
  revokeSessionsForMemberMock.mockResolvedValue(undefined);
});

describe("dashboard revoke-all sessions route", () => {
  it("returns 401 when unauthenticated and does not revoke", async () => {
    authMock.mockResolvedValue({ userId: null });
    const res = await POST();
    expect(res.status).toBe(401);
    expect(revokeSessionsForMemberMock).not.toHaveBeenCalled();
  });

  it("looks up only the user's own active sessions when finding orgs", async () => {
    await POST();
    expect(selectDistinctWhere).toHaveBeenCalledTimes(1);
    expect(selectDistinctWhere.mock.calls[0][0]).toStrictEqual(
      and(eq(cliSessions.userId, "user_1"), isNull(cliSessions.revokedAt))
    );
  });

  it("revokes the user's sessions in every org they have active sessions in", async () => {
    orgRows = [{ orgId: "personal_user_1" }, { orgId: "org_team_1" }];
    const res = await POST();
    expect(res.status).toBe(204);
    expect(revokeSessionsForMemberMock).toHaveBeenCalledTimes(2);
    expect(revokeSessionsForMemberMock).toHaveBeenNthCalledWith(
      1,
      "personal_user_1",
      "user_1"
    );
    expect(revokeSessionsForMemberMock).toHaveBeenNthCalledWith(
      2,
      "org_team_1",
      "user_1"
    );
  });

  it("succeeds with no revocations when the user has no active sessions", async () => {
    orgRows = [];
    const res = await POST();
    expect(res.status).toBe(204);
    expect(revokeSessionsForMemberMock).not.toHaveBeenCalled();
  });
});
