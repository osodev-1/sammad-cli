import { NextRequest } from "next/server";
import { ok, err } from "@/lib/http/envelope";
import { authenticateWorkspace } from "@/lib/workspace/proxy";
import { getSession as getProject } from "@/lib/compute/sessions";
import {
  createSession,
  getOrCreateDefaultSession,
  listSessions,
} from "@/lib/sessions/store";

/** Sessions (restorable work state) inside one project. */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const gate = await authenticateWorkspace();
  if (!gate.ok) return gate.response;
  const { projectId } = await params;
  // Ownership: the project must be the caller's own machine.
  const project = await getProject(gate.userId, projectId);
  if (!project) return err(404, "not_found", "No such project");
  // Guarantee at least the default session exists, then list.
  await getOrCreateDefaultSession(gate.userId, projectId);
  const sessions = await listSessions(gate.userId, projectId);
  return ok({ sessions });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const gate = await authenticateWorkspace();
  if (!gate.ok) return gate.response;
  const { projectId } = await params;
  const project = await getProject(gate.userId, projectId);
  if (!project) return err(404, "not_found", "No such project");
  const body = (await req.json().catch(() => null)) as { name?: string } | null;
  const name = body?.name?.trim();
  if (!name) return err(400, "invalid_request", "A session needs a name");
  const session = await createSession(gate.userId, projectId, name);
  return ok({ session });
}
