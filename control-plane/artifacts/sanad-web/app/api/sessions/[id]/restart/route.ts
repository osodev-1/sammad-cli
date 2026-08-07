import { NextRequest } from "next/server";
import { ok, err } from "@/lib/http/envelope";
import { authenticateWorkspace } from "@/lib/workspace/proxy";
import { restartSession } from "@/lib/compute/sessions";

/**
 * Stop the session's machine now; the next connect wakes it fresh on the
 * current image. Files persist, the agent conversation resumes — this is a
 * reboot, not a reset.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const gate = await authenticateWorkspace();
  if (!gate.ok) return gate.response;
  const { id } = await params;
  const done = await restartSession(gate.userId, id);
  if (!done) return err(404, "not_found", "No such session");
  return ok({ restarted: true });
}
