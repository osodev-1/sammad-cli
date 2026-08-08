import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db";
import { runtimeTokens, cliSessions } from "../db/schema";
import { newToken, hashToken } from "../auth/tokens";
import { requireEntitled } from "../auth/entitlement";
import { assertWithinQuota } from "../billing/quota";
import { MODEL_CATALOG, DEFAULT_MODEL_ALIAS } from "../models/catalog";

const GATEWAY_BASE_URL =
  process.env.GATEWAY_BASE_URL ?? "https://gateway.sanadcode.com/v1";

const RUNTIME_TTL_MS = 10 * 60 * 1000; // 10 min
const RUNTIME_ABSOLUTE_TTL_MS = 24 * 60 * 60 * 1000; // 24 h

export class EntitlementError extends Error {
  constructor(public readonly reason: "no_plan" | "no_seat") {
    super(`Entitlement check failed: ${reason}`);
  }
}

export async function mintRuntime(session: {
  sessionId: string;
  userId: string;
  orgId: string;
}) {
  const ent = await requireEntitled(session.orgId, session.userId);
  if (!ent.ok) throw new EntitlementError(ent.reason);

  // Entitlement says "may this org use sanad at all"; quota says "has it used
  // up this month". Both must pass before we hand out gateway access.
  await assertWithinQuota(session.orgId);

  const plainToken = newToken("rtok");
  const tokenId = crypto.randomUUID();
  const familyId = newToken("fam");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + RUNTIME_TTL_MS);
  const absoluteExpiresAt = new Date(now.getTime() + RUNTIME_ABSOLUTE_TTL_MS);

  await db.insert(runtimeTokens).values({
    id: tokenId,
    tokenHash: hashToken(plainToken),
    familyId,
    cliSessionId: session.sessionId,
    expiresAt,
    absoluteExpiresAt,
  });

  return {
    token: plainToken,
    tokenId,
    familyId,
    expiresAt: expiresAt.toISOString(),
    absoluteExpiresAt: absoluteExpiresAt.toISOString(),
    gatewayBaseUrl: GATEWAY_BASE_URL,
    modelSettings: MODEL_CATALOG.map((m) => ({
      name: m.name,
      maxContextSize: m.maxContextSize,
      capabilities: [...m.capabilities],
    })),
    defaultModelAlias: DEFAULT_MODEL_ALIAS,
  };
}

export async function renewRuntime(
  session: { sessionId: string; userId: string; orgId: string },
  tokenId: string
): Promise<{ expiresAt: string }> {
  // Re-check entitlement on every renewal so a lapsed subscription or a
  // revoked seat cannot keep extending an existing runtime token.
  const ent = await requireEntitled(session.orgId, session.userId);
  if (!ent.ok) throw new EntitlementError(ent.reason);

  // Re-check quota on renewal too. A 10-minute token would otherwise keep
  // being extended for the rest of its 24h absolute window after the org ran
  // out, so exhausting the allowance would have no effect until the next day.
  await assertWithinQuota(session.orgId);

  const [row] = await db
    .select()
    .from(runtimeTokens)
    .where(
      and(
        eq(runtimeTokens.id, tokenId),
        eq(runtimeTokens.cliSessionId, session.sessionId),
        isNull(runtimeTokens.revokedAt)
      )
    )
    .limit(1);

  if (!row) throw new Error("token_not_found");

  const now = new Date();
  if (row.absoluteExpiresAt <= now) throw new Error("token_expired");

  const newExpiry = new Date(
    Math.min(
      now.getTime() + RUNTIME_TTL_MS,
      row.absoluteExpiresAt.getTime()
    )
  );

  await db
    .update(runtimeTokens)
    .set({ expiresAt: newExpiry })
    .where(eq(runtimeTokens.id, tokenId));

  return { expiresAt: newExpiry.toISOString() };
}

export type RuntimeTokenInfo = {
  tokenId: string;
  cliSessionId: string;
  userId: string;
  orgId: string;
  /** The workspace project the owning session was born in, or null. */
  projectId: string | null;
};

/**
 * Verify an `Authorization: Bearer <runtime token>` header.
 *
 * Runtime tokens are what the gateway holds, so usage reporting authenticates
 * with them rather than the long-lived CLI session token — the gateway never
 * sees a session token. Resolves through to the owning session so a usage
 * event can be attributed to an org and user.
 *
 * Rejects tokens that are revoked, past either expiry, or whose parent session
 * has been revoked (logout must cut off reporting immediately, not at expiry).
 */
export async function verifyRuntimeBearer(
  request: Request
): Promise<RuntimeTokenInfo | null> {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;

  const plain = header.slice(7).trim();
  if (!plain) return null;

  const [row] = await db
    .select({
      tokenId: runtimeTokens.id,
      cliSessionId: runtimeTokens.cliSessionId,
      expiresAt: runtimeTokens.expiresAt,
      absoluteExpiresAt: runtimeTokens.absoluteExpiresAt,
      userId: cliSessions.userId,
      orgId: cliSessions.orgId,
      projectId: cliSessions.projectId,
      sessionRevokedAt: cliSessions.revokedAt,
    })
    .from(runtimeTokens)
    .innerJoin(cliSessions, eq(runtimeTokens.cliSessionId, cliSessions.id))
    .where(
      and(
        eq(runtimeTokens.tokenHash, hashToken(plain)),
        isNull(runtimeTokens.revokedAt)
      )
    )
    .limit(1);

  if (!row || row.sessionRevokedAt) return null;

  const now = new Date();
  if (row.expiresAt <= now || row.absoluteExpiresAt <= now) return null;

  return {
    tokenId: row.tokenId,
    cliSessionId: row.cliSessionId,
    userId: row.userId,
    orgId: row.orgId,
    projectId: row.projectId,
  };
}

/**
 * Revoke all non-revoked runtime tokens minted for a CLI session.
 * Used when a session is revoked (e.g. logout) so gateway tokens
 * are cut off immediately instead of living until expiry.
 */
export async function revokeRuntimeTokensForSession(
  sessionId: string
): Promise<void> {
  await db
    .update(runtimeTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(runtimeTokens.cliSessionId, sessionId),
        isNull(runtimeTokens.revokedAt)
      )
    );
}

export async function revokeFamily(
  session: { sessionId: string },
  familyId: string
): Promise<void> {
  await db
    .update(runtimeTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(runtimeTokens.familyId, familyId),
        eq(runtimeTokens.cliSessionId, session.sessionId),
        isNull(runtimeTokens.revokedAt)
      )
    );
}
