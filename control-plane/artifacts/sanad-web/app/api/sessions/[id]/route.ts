import { NextRequest } from "next/server";
import { ok, err } from "@/lib/http/envelope";
import { authenticateWorkspace } from "@/lib/workspace/proxy";
import { renameSession } from "@/lib/compute/sessions";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
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
