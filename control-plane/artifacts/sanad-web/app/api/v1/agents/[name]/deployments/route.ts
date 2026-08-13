import { NextRequest } from "next/server";
import { ok, err } from "@/lib/http/envelope";
import { verifyBearer } from "@/lib/auth/session";
import {
  createDeployment,
  getAgentByName,
  OwnerRequiredError,
  setDeploymentStatus,
  VersionMismatchError,
} from "@/lib/agents/registry";

function isEnv(v: unknown): v is "dev" | "prod" {
  return v === "dev" || v === "prod";
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const session = await verifyBearer(req);
  if (!session) {
    return err(401, "unauthorized", "Invalid or revoked session token");
  }

  const { name } = await params;
  const agent = await getAgentByName(session.orgId, name);
  if (!agent) {
    return err(404, "not_found", "No such agent");
  }

  const body = (await req.json().catch(() => null)) as
    | { versionId?: string; env?: string }
    | null;
  if (!body?.versionId) {
    return err(400, "invalid_request", "A deployment needs a versionId");
  }
  // mintInvoke has no runtime guard on env, so this route validates it before
  // ever reaching a registry function that expects the "dev" | "prod" union.
  if (!isEnv(body.env)) {
    return err(400, "bad_env", 'env must be "dev" or "prod"');
  }

  try {
    const { id } = await createDeployment({
      agentId: agent.id,
      versionId: body.versionId,
      env: body.env,
    });
    return ok({ deploymentId: id });
  } catch (e) {
    if (e instanceof OwnerRequiredError) {
      return err(409, "owner_required", e.message);
    }
    // 404, not 403 — a versionId from another agent must behave as not
    // found, same information-hiding rule as a cross-org agent name.
    if (e instanceof VersionMismatchError) {
      return err(404, "version_not_found", e.message);
    }
    console.error("deployment create failed", e);
    return err(500, "internal_error", "Failed to create deployment", true);
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const session = await verifyBearer(req);
  if (!session) {
    return err(401, "unauthorized", "Invalid or revoked session token");
  }

  const { name } = await params;
  const agent = await getAgentByName(session.orgId, name);
  if (!agent) {
    return err(404, "not_found", "No such agent");
  }

  const body = (await req.json().catch(() => null)) as
    | { env?: string; status?: string }
    | null;
  if (!isEnv(body?.env)) {
    return err(400, "bad_env", 'env must be "dev" or "prod"');
  }
  if (body?.status !== "active" && body?.status !== "paused") {
    return err(400, "invalid_request", 'status must be "active" or "paused"');
  }

  try {
    const matched = await setDeploymentStatus(agent.id, body.env, body.status);
    if (!matched) {
      // Same code Task 5's invoke gate uses for "no active deployment" — a
      // pause/resume with nothing live to act on is not success.
      return err(404, "not_deployed", "no active deployment for env");
    }
    return ok({ agentId: agent.id, env: body.env, status: body.status });
  } catch (e) {
    console.error("deployment status update failed", e);
    return err(500, "internal_error", "Failed to update deployment", true);
  }
}
