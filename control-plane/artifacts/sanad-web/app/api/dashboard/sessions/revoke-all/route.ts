import { auth } from "@clerk/nextjs/server";
import { db } from "@/lib/db";
import { cliSessions } from "@/lib/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import { revokeSessionsForMember } from "@/lib/auth/session";

export async function POST() {
  const { userId } = await auth();
  if (!userId) {
    return new Response("Unauthorized", { status: 401 });
  }

  // The dashboard lists every active session the user owns, across all
  // orgs (personal and team). Revoke-all must match that scope, so find
  // each org the user has active sessions in and cascade per org.
  const rows = await db
    .selectDistinct({ orgId: cliSessions.orgId })
    .from(cliSessions)
    .where(and(eq(cliSessions.userId, userId), isNull(cliSessions.revokedAt)));

  // Revoke via the shared helper so every active session and its runtime
  // tokens are cascaded — gateway access is cut off immediately.
  for (const { orgId } of rows) {
    await revokeSessionsForMember(orgId, userId);
  }

  return new Response(null, { status: 204 });
}
