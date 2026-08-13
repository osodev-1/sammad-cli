import { NextRequest, NextResponse } from "next/server";
import { parse as parseYaml } from "yaml";
import { err } from "@/lib/http/envelope";
import { verifyBearer } from "@/lib/auth/session";
import { getActiveDeployment, getAgentByName, getVersionBundle } from "@/lib/agents/registry";
import { buildAgentOpenApi } from "@/lib/agents/openapi";

type WorkerYaml = {
  interface?: {
    inputs?: Record<string, string>;
    outputs?: Record<string, string>;
  };
};

/**
 * Per-agent OpenAPI document (RT-3). Unlike every other /api/v1/agents/*
 * route, the response is the raw OpenAPI object itself — no {data, meta}
 * envelope — since this is meant to be fed straight to OpenAPI tooling.
 * Errors still use the shared envelope (err()) though: a 401/404/500 here is
 * a control-plane response, not part of the document being described.
 */
export async function GET(
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

  // Prefer prod's active deployment; fall back to dev's. A paused deployment
  // does not count — the OpenAPI document describes what a caller can
  // actually invoke right now, same as getActiveDeployment's "active" only
  // filter (unlike the invoke route's getLiveDeployment, which also needs to
  // see paused rows to return 409 instead of 404).
  const deployment =
    (await getActiveDeployment(agent.id, "prod")) ??
    (await getActiveDeployment(agent.id, "dev"));
  if (!deployment) {
    return err(404, "not_deployed", "agent has no active deployment");
  }

  const bundle = await getVersionBundle(deployment.agentVersionId);
  const workerYamlText = bundle?.files["worker.yaml"];
  if (!workerYamlText) {
    // The deployed version's bundle is missing its interface sidecar —
    // that's a data-integrity problem, not a client mistake.
    console.error(
      `openapi: version ${deployment.agentVersionId} bundle is missing worker.yaml`
    );
    return err(500, "internal_error", "agent version bundle is missing worker.yaml", true);
  }

  let parsed: WorkerYaml;
  try {
    parsed = (parseYaml(workerYamlText) ?? {}) as WorkerYaml;
  } catch (e) {
    console.error(
      `openapi: failed to parse worker.yaml for version ${deployment.agentVersionId}`,
      e
    );
    return err(500, "internal_error", "worker.yaml could not be parsed", true);
  }

  const doc = buildAgentOpenApi({
    agentName: agent.name,
    interfaceSpec: {
      inputs: parsed.interface?.inputs ?? {},
      outputs: parsed.interface?.outputs ?? {},
    },
  });
  return NextResponse.json(doc);
}
