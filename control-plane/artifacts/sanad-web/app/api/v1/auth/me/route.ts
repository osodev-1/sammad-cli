import { NextRequest } from "next/server";
import { ok, err } from "@/lib/http/envelope";
import { verifyBearer, getSessionMembership } from "@/lib/auth/session";

export async function GET(req: NextRequest) {
  const session = await verifyBearer(req);
  if (!session) {
    return err(401, "unauthorized", "Invalid or revoked session token");
  }

  const membership = await getSessionMembership(session.userId, session.orgId);
  if (!membership) {
    return err(401, "unauthorized", "Membership not found");
  }

  return ok({
    userId: session.userId,
    organizationId: session.orgId,
    membershipId: membership.id,
    role: membership.role,
    permissions: [] as string[],
  });
}
