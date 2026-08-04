import { describe, it, expect, vi, beforeEach } from "vitest";
import { and, eq, isNull } from "drizzle-orm";

let selectRows: unknown[] = [];
// `.where()` must be awaitable directly (session lookups) AND chainable with
// `.limit()` (runtime token lookup).
const selectWhere = vi.fn((_where?: unknown) =>
  Object.assign(Promise.resolve(selectRows), {
    limit: vi.fn(async () => selectRows),
  })
);
const updateWhere = vi.fn();
const updateSet = vi.fn();
const updateTargets: unknown[] = [];

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: selectWhere,
      })),
    })),
    update: vi.fn((table: unknown) => {
      updateTargets.push(table);
      return {
        set: updateSet.mockImplementation(() => ({ where: updateWhere })),
      };
    }),
    insert: vi.fn(),
  },
}));

vi.mock("@/lib/auth/entitlement", () => ({
  requireEntitled: vi.fn(),
}));

// Metering is covered in quota-enforcement.test.ts. Stubbed here so the real
// aggregate query doesn't need a deeper db mock or skew the call-count
// assertions on selectWhere.
vi.mock("@/lib/billing/quota", () => ({
  assertWithinQuota: vi.fn(),
}));

import { cliSessions, runtimeTokens } from "@/lib/db/schema";
import { requireEntitled } from "@/lib/auth/entitlement";
import {
  revokeSessionsForMember,
  revokeSessionsForOrg,
} from "@/lib/auth/session";
import { renewRuntime, EntitlementError } from "@/lib/tokens/runtime";

const SESSION = { sessionId: "sess_1", userId: "u1", orgId: "o1" };

beforeEach(() => {
  vi.clearAllMocks();
  updateTargets.length = 0;
  updateWhere.mockResolvedValue(undefined);
  selectRows = [];
});

describe("revokeSessionsForMember", () => {
  it("looks up only the member's non-revoked sessions in the org", async () => {
    await revokeSessionsForMember("o1", "u1");

    expect(selectWhere).toHaveBeenCalledTimes(1);
    expect(selectWhere.mock.calls[0][0]).toStrictEqual(
      and(
        eq(cliSessions.orgId, "o1"),
        eq(cliSessions.userId, "u1"),
        isNull(cliSessions.revokedAt)
      )
    );
    // No sessions → nothing revoked.
    expect(updateTargets).toStrictEqual([]);
  });

  it("revokes each session and cascades to its runtime tokens", async () => {
    selectRows = [{ id: "sess_a" }, { id: "sess_b" }];

    await revokeSessionsForMember("o1", "u1");

    // Per session: cliSessions update, then runtimeTokens cascade.
    expect(updateTargets).toStrictEqual([
      cliSessions,
      runtimeTokens,
      cliSessions,
      runtimeTokens,
    ]);
    expect(updateWhere.mock.calls[0][0]).toStrictEqual(
      eq(cliSessions.id, "sess_a")
    );
    expect(updateWhere.mock.calls[1][0]).toStrictEqual(
      and(
        eq(runtimeTokens.cliSessionId, "sess_a"),
        isNull(runtimeTokens.revokedAt)
      )
    );
    expect(updateWhere.mock.calls[2][0]).toStrictEqual(
      eq(cliSessions.id, "sess_b")
    );
  });
});

describe("revokeSessionsForOrg", () => {
  it("revokes every non-revoked session in the org with cascade", async () => {
    selectRows = [{ id: "sess_x" }];

    await revokeSessionsForOrg("o1");

    expect(selectWhere.mock.calls[0][0]).toStrictEqual(
      and(eq(cliSessions.orgId, "o1"), isNull(cliSessions.revokedAt))
    );
    expect(updateTargets).toStrictEqual([cliSessions, runtimeTokens]);
    expect(updateWhere.mock.calls[0][0]).toStrictEqual(
      eq(cliSessions.id, "sess_x")
    );
  });
});

describe("renewRuntime entitlement re-check", () => {
  it("throws EntitlementError(no_plan) when the org's plan lapsed", async () => {
    vi.mocked(requireEntitled).mockResolvedValue({
      ok: false,
      reason: "no_plan",
    });

    await expect(renewRuntime(SESSION, "tok_1")).rejects.toThrow(
      EntitlementError
    );
    // Entitlement fails before any token lookup or extension.
    expect(selectWhere).not.toHaveBeenCalled();
    expect(updateTargets).toStrictEqual([]);
  });

  it("throws EntitlementError(no_seat) when the member's seat was revoked", async () => {
    vi.mocked(requireEntitled).mockResolvedValue({
      ok: false,
      reason: "no_seat",
    });

    await expect(renewRuntime(SESSION, "tok_1")).rejects.toMatchObject({
      reason: "no_seat",
    });
    expect(updateTargets).toStrictEqual([]);
  });

  it("checks entitlement with the session's org and user", async () => {
    vi.mocked(requireEntitled).mockResolvedValue({ ok: true });

    await expect(renewRuntime(SESSION, "tok_1")).rejects.toThrow(
      "token_not_found"
    );
    expect(requireEntitled).toHaveBeenCalledWith("o1", "u1");
  });
});
