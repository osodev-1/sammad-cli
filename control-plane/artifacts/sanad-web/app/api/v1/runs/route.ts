import { NextRequest } from "next/server";
import { ok, err } from "@/lib/http/envelope";
import { verifyBearer } from "@/lib/auth/session";
import { getAgentByName } from "@/lib/agents/registry";
import { listRuns, serializeRun } from "@/lib/runs/store";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/** Clamp to [1, MAX_LIMIT]; anything unparsable falls back to the default. */
function parseLimit(raw: string | null): number {
  if (!raw) return DEFAULT_LIMIT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

/**
 * Runs list — session-authed, org-scoped (see lib/runs/store.ts's listRuns).
 * `agent` filters by name, resolved to an id within the caller's own org
 * first: an agent name that doesn't exist (here, or at all) yields an empty
 * list rather than an error — same non-leaking shape either way.
 */
export async function GET(req: NextRequest) {
  const session = await verifyBearer(req);
  if (!session) {
    return err(401, "unauthorized", "Invalid or revoked session token");
  }

  const sp = req.nextUrl.searchParams;
  const agentName = sp.get("agent");
  const env = sp.get("env") ?? undefined;
  const status = sp.get("status") ?? undefined;
  const limit = parseLimit(sp.get("limit"));

  let agentId: string | undefined;
  if (agentName) {
    const agent = await getAgentByName(session.orgId, agentName);
    if (!agent) return ok({ runs: [] });
    agentId = agent.id;
  }

  const rows = await listRuns({ orgId: session.orgId, agentId, env, status, limit });
  return ok({ runs: rows.map(serializeRun) });
}
