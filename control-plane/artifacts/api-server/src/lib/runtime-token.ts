import { createHash } from "node:crypto";
import { pool } from "./db";

/** SHA-256 hex — must match the control plane's hashToken (lib/auth/tokens.ts). */
const hashToken = (token: string): string =>
  createHash("sha256").update(token).digest("hex");

export interface RuntimeIdentity {
  tokenId: string;
  cliSessionId: string;
  userId: string;
  orgId: string;
}

/**
 * Validate an opaque runtime token against the shared Postgres, replicating the
 * control plane's verifyRuntimeBearer (sanad-web/lib/tokens/runtime.ts) exactly:
 * the token is valid iff a non-revoked runtime_tokens row hashes to it, its
 * cli_session isn't revoked, and neither the sliding nor the absolute expiry has
 * passed. Returns the owning org/user/session, or null.
 */
export async function validateRuntimeToken(
  plain: string
): Promise<RuntimeIdentity | null> {
  const { rows } = await pool.query<{
    token_id: string;
    cli_session_id: string;
    expires_at: Date;
    absolute_expires_at: Date;
    user_id: string;
    org_id: string;
    session_revoked_at: Date | null;
  }>(
    `SELECT rt.id                 AS token_id,
            rt.cli_session_id     AS cli_session_id,
            rt.expires_at         AS expires_at,
            rt.absolute_expires_at AS absolute_expires_at,
            cs.user_id            AS user_id,
            cs.org_id             AS org_id,
            cs.revoked_at         AS session_revoked_at
       FROM runtime_tokens rt
       JOIN cli_sessions cs ON cs.id = rt.cli_session_id
      WHERE rt.token_hash = $1 AND rt.revoked_at IS NULL
      LIMIT 1`,
    [hashToken(plain)]
  );

  const row = rows[0];
  if (!row || row.session_revoked_at) return null;

  const now = Date.now();
  if (
    new Date(row.expires_at).getTime() <= now ||
    new Date(row.absolute_expires_at).getTime() <= now
  ) {
    return null;
  }

  return {
    tokenId: row.token_id,
    cliSessionId: row.cli_session_id,
    userId: row.user_id,
    orgId: row.org_id,
  };
}
