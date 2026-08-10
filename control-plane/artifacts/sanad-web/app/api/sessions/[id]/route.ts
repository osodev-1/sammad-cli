import { NextRequest } from "next/server";
import { ok, err } from "@/lib/http/envelope";
import { authenticateWorkspace } from "@/lib/workspace/proxy";
import { computeMode } from "@/lib/compute/mode";
import { deleteSession, renameSession } from "@/lib/compute/sessions";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const gate = await authenticateWorkspace();
  if (!gate.ok) return gate.response;
  const { id } = await params;
  const body = (await req.json().catch(() => null)) as { name?: string } | null;
  const name = body?.name?.trim();
  if (!name) return err(400, "invalid_request", "A session needs a name");
  const row = await renameSession(gate.userId, id, name);
  if (!row) return err(404, "not_found", "No such session");
  return ok({ session: { id: row.id, name: row.name, state: row.state } });
}

/**
 * Delete a project. Cascades through everything downstream — machine stopped,
 * EFS access point removed (files unreachable), project-born CLI sessions
 * revoked (runtime tokens cut off), PRD-session rows deleted — then the row.
 * Ownership-scoped; deleting the last project is fine (the next visit
 * auto-creates "main").
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const gate = await authenticateWorkspace();
  if (!gate.ok) return gate.response;
  if (computeMode() !== "aws") {
    return err(
      503,
      "sessions_unavailable",
      "Sessions need the compute platform",
    );
  }
  const { id } = await params;
  try {
    const deleted = await deleteSession(gate.userId, id);
    if (!deleted) return err(404, "not_found", "No such session");
    return ok({ deleted: true });
  } catch (e) {
    console.error("session delete failed", e);
    return err(
      503,
      "session_delete_failed",
      "Could not delete the project",
      true,
    );
  }
}
