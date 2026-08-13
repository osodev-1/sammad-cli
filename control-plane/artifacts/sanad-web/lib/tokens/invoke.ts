import { and, eq, gt, isNull } from "drizzle-orm";
import { db } from "../db";
import { invokeTokens } from "../db/schema";
import { newToken, hashToken } from "../auth/tokens";
import { requireEntitled } from "../auth/entitlement";
import { assertWithinQuota } from "../billing/quota";
import { EntitlementError } from "./runtime";

const INVOKE_TTL_MS = 90 * 24 * 3600 * 1000;

export interface InvokeTokenInfo {
  tokenId: string;
  agentId: string;
  env: string;
  orgId: string;
}

export async function mintInvoke(
  session: { userId: string; orgId: string },
  agentId: string,
  env: "dev" | "prod"
): Promise<{ token: string; tokenId: string; expiresAt: Date }> {
  const ent = await requireEntitled(session.orgId, session.userId);
  if (!ent.ok) throw new EntitlementError(ent.reason);
  await assertWithinQuota(session.orgId);

  const token = newToken("itok");
  const tokenId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + INVOKE_TTL_MS);
  await db.insert(invokeTokens).values({
    id: tokenId,
    tokenHash: hashToken(token),
    familyId: newToken("ifam"),
    agentId,
    env,
    orgId: session.orgId,
    createdBy: session.userId,
    expiresAt,
  });
  return { token, tokenId, expiresAt };
}

export async function verifyInvokeBearer(request: Request): Promise<InvokeTokenInfo | null> {
  const auth = request.headers.get("authorization") ?? "";
  const m = auth.match(/^Bearer (itok_[A-Za-z0-9_-]+)$/);
  if (!m) return null;
  const rows = await db
    .select()
    .from(invokeTokens)
    .where(
      and(
        eq(invokeTokens.tokenHash, hashToken(m[1])),
        isNull(invokeTokens.revokedAt),
        gt(invokeTokens.expiresAt, new Date())
      )
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return { tokenId: row.id, agentId: row.agentId, env: row.env, orgId: row.orgId };
}

export async function revokeInvokeFamily(familyId: string): Promise<void> {
  await db
    .update(invokeTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(invokeTokens.familyId, familyId), isNull(invokeTokens.revokedAt)));
}
