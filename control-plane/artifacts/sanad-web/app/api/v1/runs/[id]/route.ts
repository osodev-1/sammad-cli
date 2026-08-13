import { NextRequest } from "next/server";
import { ok, err } from "@/lib/http/envelope";
import { verifyBearer } from "@/lib/auth/session";
import { getRunForOrg, serializeRun } from "@/lib/runs/store";

/**
 * A single run — session-authed, org-scoped. A run id from another org is
 * indistinguishable from one that doesn't exist at all (both 404
 * `not_found`) — same information-hiding rule as agent name resolution.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await verifyBearer(req);
  if (!session) {
    return err(401, "unauthorized", "Invalid or revoked session token");
  }

  const { id } = await params;
  const row = await getRunForOrg(id, session.orgId);
  if (!row) {
    return err(404, "not_found", "No such run");
  }

  return ok({ run: serializeRun(row) });
}
