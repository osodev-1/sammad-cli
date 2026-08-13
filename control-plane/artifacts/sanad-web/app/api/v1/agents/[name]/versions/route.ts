import { NextRequest } from "next/server";
import { ok, err } from "@/lib/http/envelope";
import { verifyBearer } from "@/lib/auth/session";
import { createVersion, getAgentByName } from "@/lib/agents/registry";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const session = await verifyBearer(req);
  if (!session) {
    return err(401, "unauthorized", "Invalid or revoked session token");
  }

  const { name } = await params;
  // Resolve within the caller's org only — an agent from another org must
  // behave as not found, never leak its existence via a 403.
  const agent = await getAgentByName(session.orgId, name);
  if (!agent) {
    return err(404, "not_found", "No such agent");
  }

  const body = (await req.json().catch(() => null)) as
    | { files?: Record<string, string> }
    | null;
  const files = body?.files;
  if (!files || typeof files !== "object" || Array.isArray(files) || Object.keys(files).length === 0) {
    return err(400, "invalid_request", "A version needs a non-empty files map");
  }

  try {
    const { id, contentHash } = await createVersion({
      agentId: agent.id,
      files,
      createdBy: session.userId,
    });
    return ok({ versionId: id, contentHash });
  } catch (e) {
    console.error("version create failed", e);
    return err(500, "internal_error", "Failed to create version", true);
  }
}
