import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "@/lib/db";
import { cliSessions } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
import { revokeSession } from "@/lib/auth/session";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { userId } = await auth();
  if (!userId) {
    return new Response("Unauthorized", { status: 401 });
  }

  const { sessionId } = await params;

  // Only allow revoking sessions owned by the current user
  const [session] = await db
    .select({ id: cliSessions.id })
    .from(cliSessions)
    .where(
      and(eq(cliSessions.id, sessionId), eq(cliSessions.userId, userId))
    )
    .limit(1);

  if (!session) {
    return new Response("Not Found", { status: 404 });
  }

  // Revoke via the shared helper so runtime tokens are cascaded and
  // gateway access is cut off immediately, not at token expiry.
  await revokeSession(session.id);

  return new Response(null, { status: 204 });
}
