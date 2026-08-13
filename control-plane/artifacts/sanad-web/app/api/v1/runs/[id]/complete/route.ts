import { NextRequest } from "next/server";
import { z } from "zod";
import { ok, err } from "@/lib/http/envelope";
import { completeRun, getRun } from "@/lib/runs/store";
import { getAgentById, getDeploymentById, getWorkspaceById } from "@/lib/agents/registry";
import { getMachineByWorkspaceEnv, touchMachineLastSeen } from "@/lib/compute/machines";
import { machineTokenMatches } from "@/lib/compute/tokens";

const Body = z.object({
  status: z.enum(["succeeded", "failed", "cancelled"]),
  errorCode: z.string().min(1).max(128).optional(),
  output: z.unknown().optional(),
  tokensIn: z.number().int().min(0),
  tokensOut: z.number().int().min(0),
  modelAlias: z.string().min(1).max(128).optional(),
  traceUploaded: z.boolean(),
});

/**
 * Completion ingest — Bearer-authed by the run's own workspace machine, not
 * a user session. The machine holds no signed token from us; instead we
 * walk run -> deployment -> agent -> workspace -> workspaceMachines to find
 * the machine's runNonce, recompute deriveMachineToken(workspaceId,
 * runNonce) (machineTokenMatches — same HMAC-then-timingSafeEqual pattern
 * as app/api/v1/compute/route/route.ts:8-14), and compare.
 *
 * Every resolution failure along that chain — run not found, deployment or
 * agent missing (shouldn't happen given FK integrity, but not trusted),
 * no workspaceMachines row for this (workspace, env), or a row with no
 * runNonce yet — collapses to the same 401. There is no way to distinguish
 * "which link is missing" in the response without also telling a caller
 * holding a stale or foreign token something about run/agent existence, so
 * this fails closed uniformly.
 *
 * Idempotent by construction: completeRun's UPDATE only matches rows still
 * in "queued"/"running", so a retried completion (or one racing the reaper)
 * is a no-op — this always answers 200 with whatever the run's status ends
 * up being, not necessarily the status the caller just posted.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const header = req.headers.get("authorization");
  const presented = header?.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!presented) {
    return err(401, "unauthorized", "Missing machine bearer token");
  }

  const { id: runId } = await params;
  const run = await getRun(runId);
  const deployment = run ? await getDeploymentById(run.deploymentId) : null;
  const agent = deployment ? await getAgentById(deployment.agentId) : null;
  const workspace = agent ? await getWorkspaceById(agent.workspaceId) : null;
  const machine =
    workspace && deployment
      ? await getMachineByWorkspaceEnv(workspace.id, deployment.env)
      : null;

  if (!run || !deployment || !agent || !workspace || !machine || !machine.runNonce) {
    return err(401, "unauthorized", "Invalid machine credential");
  }
  if (!machineTokenMatches(presented, workspace.id, machine.runNonce)) {
    return err(401, "unauthorized", "Invalid machine credential");
  }

  // Proof of life: this POST only reaches here on a valid machine
  // credential, so it's as good a staleness signal as a warm-attach probe —
  // refresh it so lib/runs/reaper.ts's staleness check doesn't reap a run
  // whose machine has been silently alive this whole time.
  await touchMachineLastSeen(machine.id);

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return err(400, "invalid_request", "Request body must be JSON");
  }
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    return err(400, "invalid_request", parsed.error.issues[0]?.message ?? "Invalid completion payload");
  }

  await completeRun(runId, parsed.data);

  const finalRow = await getRun(runId);
  return ok({ runId, status: finalRow?.status ?? run.status });
}
