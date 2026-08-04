import { NextRequest } from "next/server";
import { err } from "@/lib/http/envelope";
import { verifyBearer, revokeSession } from "@/lib/auth/session";

export async function POST(req: NextRequest) {
  const session = await verifyBearer(req);
  if (!session) {
    return err(401, "unauthorized", "Invalid or revoked session token");
  }

  await revokeSession(session.sessionId);

  return new Response(null, { status: 204 });
}
