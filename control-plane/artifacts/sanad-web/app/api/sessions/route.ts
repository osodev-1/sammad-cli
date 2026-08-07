import { NextRequest } from "next/server";
import { ok, err } from "@/lib/http/envelope";
import { authenticateWorkspace } from "@/lib/workspace/proxy";
import { computeMode } from "@/lib/compute/mode";
import {
  createSession,
  getOrCreateMainSession,
  listSessions,
  MAX_SESSIONS_PER_USER,
  type SessionRow,
} from "@/lib/compute/sessions";

/** Public shape — machine internals (task ARNs, IPs, APs) never leave here. */
function publicSession(row: SessionRow) {
  return {
    id: row.id,
    name: row.name,
    state: row.taskArn && row.state === "ready" ? "ready" : row.state,
    createdAt: row.createdAt,
  };
}

export async function GET() {
  const gate = await authenticateWorkspace();
  if (!gate.ok) return gate.response;
  if (computeMode() !== "aws") {
    return err(503, "sessions_unavailable", "Sessions need the compute platform");
  }
  // First touch materializes the default session so the list is never empty.
  await getOrCreateMainSession(gate.userId);
  const rows = await listSessions(gate.userId);
  return ok({ sessions: rows.map(publicSession), limit: MAX_SESSIONS_PER_USER });
}

export async function POST(req: NextRequest) {
  const gate = await authenticateWorkspace();
  if (!gate.ok) return gate.response;
  if (computeMode() !== "aws") {
    return err(503, "sessions_unavailable", "Sessions need the compute platform");
  }
  const body = (await req.json().catch(() => null)) as { name?: string } | null;
  const name = body?.name?.trim();
  if (!name) return err(400, "invalid_request", "A session needs a name");
  try {
    const row = await createSession(gate.userId, name);
    return ok({ session: publicSession(row) });
  } catch (e) {
    if ((e as { code?: string }).code === "session_limit") {
      return err(409, "session_limit", `You can have up to ${MAX_SESSIONS_PER_USER} sessions`);
    }
    console.error("session create failed", e);
    return err(503, "session_create_failed", "Could not create the session", true);
  }
}
