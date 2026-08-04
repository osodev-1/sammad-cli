import { describe, it, expect, vi, beforeEach } from "vitest";
import { and, eq, isNull } from "drizzle-orm";

const selectWhere = vi.fn();
const selectLimit = vi.fn();
const updateWhere = vi.fn();
const updateSet = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: selectWhere.mockImplementation(() => ({ limit: selectLimit })),
      })),
    })),
    update: vi.fn(() => ({
      set: updateSet.mockImplementation(() => ({ where: updateWhere })),
    })),
    insert: vi.fn(),
  },
}));

vi.mock("@/lib/auth/entitlement", () => ({
  requireEntitled: vi.fn(),
}));

// These tests are about ownership scoping, not metering. The real quota gate
// runs its own aggregate query, which would both need a deeper db mock and
// pollute the selectWhere call-count assertions below.
vi.mock("@/lib/billing/quota", () => ({
  assertWithinQuota: vi.fn(),
}));

import { db } from "@/lib/db";
import { runtimeTokens } from "@/lib/db/schema";
import { requireEntitled } from "@/lib/auth/entitlement";
import { renewRuntime, revokeFamily } from "@/lib/tokens/runtime";

const SESSION = { sessionId: "sess_owner", userId: "u1", orgId: "o1" };

beforeEach(() => {
  vi.clearAllMocks();
  selectLimit.mockResolvedValue([]);
  updateWhere.mockResolvedValue(undefined);
  vi.mocked(requireEntitled).mockResolvedValue({ ok: true });
});

describe("renewRuntime ownership", () => {
  it("scopes the token lookup to the caller's CLI session", async () => {
    await expect(renewRuntime(SESSION, "tok_1")).rejects.toThrow(
      "token_not_found"
    );

    expect(selectWhere).toHaveBeenCalledTimes(1);
    const cond = selectWhere.mock.calls[0][0];
    expect(cond).toStrictEqual(
      and(
        eq(runtimeTokens.id, "tok_1"),
        eq(runtimeTokens.cliSessionId, SESSION.sessionId),
        isNull(runtimeTokens.revokedAt)
      )
    );
  });

  it("throws token_not_found when the token belongs to another session", async () => {
    // The ownership filter is part of the query, so a foreign token yields no row.
    selectLimit.mockResolvedValue([]);
    await expect(renewRuntime(SESSION, "tok_foreign")).rejects.toThrow(
      "token_not_found"
    );
    expect(db.update).not.toHaveBeenCalled();
  });

  it("renews a token owned by the caller's session", async () => {
    const now = Date.now();
    selectLimit.mockResolvedValue([
      {
        id: "tok_1",
        cliSessionId: SESSION.sessionId,
        absoluteExpiresAt: new Date(now + 60 * 60 * 1000),
      },
    ]);

    const result = await renewRuntime(SESSION, "tok_1");
    expect(new Date(result.expiresAt).getTime()).toBeGreaterThan(now);
    expect(db.update).toHaveBeenCalledTimes(1);
  });
});

describe("revokeFamily ownership", () => {
  it("only revokes families owned by the caller's CLI session", async () => {
    await revokeFamily(SESSION, "fam_1");

    expect(updateWhere).toHaveBeenCalledTimes(1);
    const cond = updateWhere.mock.calls[0][0];
    expect(cond).toStrictEqual(
      and(
        eq(runtimeTokens.familyId, "fam_1"),
        eq(runtimeTokens.cliSessionId, SESSION.sessionId),
        isNull(runtimeTokens.revokedAt)
      )
    );
    expect(updateSet).toHaveBeenCalledWith({ revokedAt: expect.any(Date) });
  });

  it("resolves without error when the family is not the caller's (no-op)", async () => {
    await expect(revokeFamily(SESSION, "fam_foreign")).resolves.toBeUndefined();
  });
});
