import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db";
import { cliSessions, memberships } from "../db/schema";
import { newToken, hashToken } from "./tokens";
import { revokeRuntimeTokensForSession } from "../tokens/runtime";

/**
 * Mint a new CLI session token. Stores only the hash at rest.
 * Returns the plaintext token for one-time use.
 */
export async function mintSession(
  userId: string,
  orgId: string,
  deviceRequestId?: string,
  deviceLabel?: string
): Promise<string> {
  const plainToken = newToken("sess");
  const tokenHash = hashToken(plainToken);

  await db.insert(cliSessions).values({
    id: crypto.randomUUID(),
    tokenHash,
    userId,
    orgId,
    deviceRequestId: deviceRequestId ?? null,
    deviceLabel: deviceLabel ?? null,
  });

  return plainToken;
}

export type SessionInfo = {
  sessionId: string;
  userId: string;
  orgId: string;
};

/**
 * Verify an Authorization: Bearer <token> header.
 * Hashes the token, looks up a non-revoked cli_sessions row, touches lastUsedAt.
 */
export async function verifyBearer(
  request: Request
): Promise<SessionInfo | null> {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;

  const plain = header.slice(7).trim();
  if (!plain) return null;

  const hash = hashToken(plain);
  const [session] = await db
    .select()
    .from(cliSessions)
    .where(
      and(eq(cliSessions.tokenHash, hash), isNull(cliSessions.revokedAt))
    )
    .limit(1);

  if (!session) return null;

  // Touch lastUsedAt (fire-and-forget)
  void db
    .update(cliSessions)
    .set({ lastUsedAt: new Date() })
    .where(eq(cliSessions.id, session.id));

  return { sessionId: session.id, userId: session.userId, orgId: session.orgId };
}

/**
 * Fetch role and membership id for a session's user+org.
 */
export async function getSessionMembership(userId: string, orgId: string) {
  const [m] = await db
    .select()
    .from(memberships)
    .where(and(eq(memberships.userId, userId), eq(memberships.orgId, orgId)))
    .limit(1);
  return m ?? null;
}

/**
 * Revoke a CLI session by session id.
 * Also revokes all runtime tokens minted for the session so gateway
 * access is cut off immediately, not at token expiry.
 */
export async function revokeSession(sessionId: string): Promise<void> {
  await db
    .update(cliSessions)
    .set({ revokedAt: new Date() })
    .where(eq(cliSessions.id, sessionId));

  await revokeRuntimeTokensForSession(sessionId);
}

/**
 * Revoke every active CLI session (and cascaded runtime tokens) for a user
 * within an org. Used when a member loses entitlement — seat revoked or
 * removed — so CLI access is cut off immediately, not at token expiry.
 */
export async function revokeSessionsForMember(
  orgId: string,
  userId: string
): Promise<void> {
  const sessions = await db
    .select({ id: cliSessions.id })
    .from(cliSessions)
    .where(
      and(
        eq(cliSessions.orgId, orgId),
        eq(cliSessions.userId, userId),
        isNull(cliSessions.revokedAt)
      )
    );

  for (const s of sessions) {
    await revokeSession(s.id);
  }
}

/**
 * Revoke every active CLI session (and cascaded runtime tokens) in an org.
 * Used when the org's plan ends (e.g. Team subscription canceled) so no
 * member keeps CLI access on a plan that no longer exists.
 */
export async function revokeSessionsForOrg(orgId: string): Promise<void> {
  const sessions = await db
    .select({ id: cliSessions.id })
    .from(cliSessions)
    .where(and(eq(cliSessions.orgId, orgId), isNull(cliSessions.revokedAt)));

  for (const s of sessions) {
    await revokeSession(s.id);
  }
}
