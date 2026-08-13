import { NextRequest } from "next/server";
import { ok, err } from "@/lib/http/envelope";
import { verifyBearer } from "@/lib/auth/session";
import { upsertAgent, listAgentsForOrg } from "@/lib/agents/registry";

const DEFAULT_WORKSPACE = "default";

export async function GET(req: NextRequest) {
  const session = await verifyBearer(req);
  if (!session) {
    return err(401, "unauthorized", "Invalid or revoked session token");
  }

  const rows = await listAgentsForOrg(session.orgId);
  return ok({
    agents: rows.map((a) => ({
      id: a.id,
      name: a.name,
      workspace: a.workspaceName,
      ownerUserId: a.ownerUserId,
      status: a.status,
      description: a.description,
      createdAt: a.createdAt,
    })),
  });
}

export async function POST(req: NextRequest) {
  const session = await verifyBearer(req);
  if (!session) {
    return err(401, "unauthorized", "Invalid or revoked session token");
  }

  const body = (await req.json().catch(() => null)) as
    | { name?: string; workspace?: string; description?: string }
    | null;
  const name = body?.name?.trim();
  if (!name) {
    return err(400, "invalid_request", "An agent needs a name");
  }
  const workspaceName = body?.workspace?.trim() || DEFAULT_WORKSPACE;

  try {
    const { id } = await upsertAgent({
      orgId: session.orgId,
      workspaceName,
      name,
      ownerUserId: session.userId,
      description: body?.description,
    });
    return ok({ agentId: id, name, workspace: workspaceName });
  } catch (e) {
    console.error("agent create failed", e);
    return err(500, "internal_error", "Failed to create agent", true);
  }
}
