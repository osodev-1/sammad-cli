import { NextRequest, NextResponse } from "next/server";
import { err } from "@/lib/http/envelope";
import { verifyBearer } from "@/lib/auth/session";
import { getRunForOrg, presignTraceGet } from "@/lib/runs/store";

/**
 * Trace download — session-authed, org-scoped (same rule as the run read
 * routes: a foreign run id 404s exactly like an unknown one). Redirects to
 * a short-lived (300s, presignTraceGet) S3 GET URL rather than proxying the
 * object through this server. `trace_unavailable` covers both "run hasn't
 * uploaded one yet" and "run never will" (failed before upload) — the
 * client can't act on the distinction, so it isn't surfaced.
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
  if (!row.traceUploaded) {
    return err(404, "trace_unavailable", "This run has no uploaded trace");
  }

  const url = await presignTraceGet(id);
  return NextResponse.redirect(url, 307);
}
