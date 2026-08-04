import { describe, it, expect, vi, beforeEach } from "vitest";
import { and, eq, isNull } from "drizzle-orm";

const updateWhere = vi.fn();
const updateSet = vi.fn();
const updateTargets: unknown[] = [];

vi.mock("@/lib/db", () => ({
  db: {
    update: vi.fn((table: unknown) => {
      updateTargets.push(table);
      return {
        set: updateSet.mockImplementation(() => ({ where: updateWhere })),
      };
    }),
    select: vi.fn(),
    insert: vi.fn(),
  },
}));

vi.mock("@/lib/auth/entitlement", () => ({
  requireEntitled: vi.fn(),
}));

import { cliSessions, runtimeTokens } from "@/lib/db/schema";
import { revokeSession } from "@/lib/auth/session";
import { revokeRuntimeTokensForSession } from "@/lib/tokens/runtime";

beforeEach(() => {
  vi.clearAllMocks();
  updateTargets.length = 0;
  updateWhere.mockResolvedValue(undefined);
});

describe("revokeRuntimeTokensForSession", () => {
  it("revokes only non-revoked tokens belonging to the session", async () => {
    await revokeRuntimeTokensForSession("sess_1");

    expect(updateTargets).toStrictEqual([runtimeTokens]);
    expect(updateSet).toHaveBeenCalledTimes(1);
    expect(updateSet.mock.calls[0][0]).toHaveProperty("revokedAt");
    expect(updateSet.mock.calls[0][0].revokedAt).toBeInstanceOf(Date);

    const cond = updateWhere.mock.calls[0][0];
    expect(cond).toStrictEqual(
      and(
        eq(runtimeTokens.cliSessionId, "sess_1"),
        isNull(runtimeTokens.revokedAt)
      )
    );
  });
});

describe("revokeSession cascade", () => {
  it("revokes the session row and all its runtime tokens", async () => {
    await revokeSession("sess_2");

    // First update targets cliSessions, second targets runtimeTokens.
    expect(updateTargets).toStrictEqual([cliSessions, runtimeTokens]);

    const sessionCond = updateWhere.mock.calls[0][0];
    expect(sessionCond).toStrictEqual(eq(cliSessions.id, "sess_2"));

    const tokenCond = updateWhere.mock.calls[1][0];
    expect(tokenCond).toStrictEqual(
      and(
        eq(runtimeTokens.cliSessionId, "sess_2"),
        isNull(runtimeTokens.revokedAt)
      )
    );
  });
});
