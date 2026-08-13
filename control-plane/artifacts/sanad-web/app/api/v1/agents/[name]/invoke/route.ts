import { NextRequest, NextResponse } from "next/server";
import { ok, err } from "@/lib/http/envelope";
import { verifyInvokeBearer } from "@/lib/tokens/invoke";
import {
  getAgentByName,
  getLiveDeployment,
  getVersionBundle,
  getWorkspaceById,
} from "@/lib/agents/registry";
import { assertWithinQuota, QuotaExceededError } from "@/lib/billing/quota";
import { ensureWorkspaceMachine, type MachineTarget } from "@/lib/compute/machines";
import { mintSession } from "@/lib/auth/session";
import {
  createRun,
  getRun,
  invokeGate,
  markRunFailed,
  markRunRunning,
  presignTracePut,
  type RunRow,
} from "@/lib/runs/store";

// How long the machine gets to come up from cold before the caller is told
// to retry instead of holding the connection open indefinitely.
const WAKE_DEADLINE_MS = 120_000;
// After the machine accepts the run and the NDJSON stream (?wait=1 path)
// ends, the worker reports completion out-of-band (Task 6/12) rather than
// in-band on the stream — so the run row may not have flipped out of
// "running" the instant the stream closes. Poll briefly for it before
// answering with whatever state exists.
const RUN_POLL_DEADLINE_MS = 10_000;
const RUN_POLL_INTERVAL_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function machineWakingResponse(): NextResponse {
  // err() has no header support and this is the one response that needs
  // Retry-After, so build the envelope directly here (same shape as err()).
  return NextResponse.json(
    {
      error: {
        code: "machine_waking",
        message: "workspace machine is starting — retry",
        requestId: crypto.randomUUID(),
        retryable: true,
      },
    },
    { status: 503, headers: { "Retry-After": "30" } }
  );
}

/** Race ensureWorkspaceMachine's cold-start wake against WAKE_DEADLINE_MS. */
async function wakeMachine(
  workspaceId: string,
  env: string,
  keepWarm: boolean
): Promise<MachineTarget | "timeout"> {
  return Promise.race([
    ensureWorkspaceMachine(workspaceId, env, { keepWarm }),
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), WAKE_DEADLINE_MS)),
  ]);
}

/** Poll a run row until it leaves "running", or RUN_POLL_DEADLINE_MS elapses. */
async function pollRunSettled(runId: string): Promise<RunRow | null> {
  const deadline = Date.now() + RUN_POLL_DEADLINE_MS;
  let row = await getRun(runId);
  while (row && row.status === "running" && Date.now() < deadline) {
    await sleep(RUN_POLL_INTERVAL_MS);
    row = await getRun(runId);
  }
  return row;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const info = await verifyInvokeBearer(req);
  if (!info) {
    return err(401, "unauthorized", "Invalid or expired invoke token");
  }

  // env comes from the token, not the caller — the query param, if present,
  // is only validated against it, never used to select the deployment.
  const qEnv = req.nextUrl.searchParams.get("env");
  if (qEnv && qEnv !== info.env) {
    return err(400, "bad_env", "env query parameter does not match the token's env");
  }

  const { name } = await params;
  const agent = await getAgentByName(info.orgId, name);
  if (!agent) {
    return err(404, "not_found", "No such agent");
  }

  const deployment = await getLiveDeployment(agent.id, info.env);
  const gate = invokeGate({
    tokenAgentId: info.agentId,
    pathAgentId: agent.id,
    deployment: deployment ? { status: deployment.status } : null,
  });
  // Priority: token scope (403) outranks quota; quota (402) outranks
  // deployment existence/pause state — matches the route's documented
  // 1/2/3 gate order even though both deployment-shaped checks share one
  // invokeGate call.
  if (!gate.ok && gate.code === "token_scope") {
    return err(gate.status, gate.code, gate.message);
  }

  try {
    await assertWithinQuota(info.orgId);
  } catch (e) {
    if (e instanceof QuotaExceededError) {
      return err(
        402,
        "quota_exceeded",
        `Monthly ${e.dimension} allowance exhausted — upgrade at sanadcode.com/pricing or wait for the next billing period`
      );
    }
    throw e;
  }

  if (!gate.ok) {
    return err(gate.status, gate.code, gate.message);
  }
  if (!deployment) {
    // Unreachable: gate.ok === true already implies a non-null, non-paused
    // deployment. Narrows the type for the rest of the handler.
    return err(500, "internal_error", "invariant violated: gate passed with no deployment", true);
  }

  const idempotencyKey = req.headers.get("idempotency-key") ?? undefined;
  const { id: runId, existing } = await createRun({
    deploymentId: deployment.id,
    agentVersionId: deployment.agentVersionId,
    triggerPrincipal: `itok:${info.tokenId}`,
    idempotencyKey,
  });

  if (existing) {
    // Idempotent replay: the machine is never re-invoked, and the response
    // shape is the same regardless of ?wait.
    const row = await getRun(runId);
    if (!row) {
      return err(500, "internal_error", "run row missing on replay", true);
    }
    return ok({ runId: row.id, status: row.status, output: row.output });
  }

  const workspace = await getWorkspaceById(agent.workspaceId);
  if (!workspace) {
    await markRunFailed(runId, "internal_error");
    return err(500, "internal_error", "agent's workspace is missing", true);
  }

  let target: MachineTarget;
  try {
    const woken = await wakeMachine(workspace.id, info.env, workspace.keepWarm);
    if (woken === "timeout") {
      await markRunFailed(runId, "wake_timeout");
      return machineWakingResponse();
    }
    target = woken;
  } catch (e) {
    console.error(`invoke: failed to wake workspace machine for run ${runId}`, e);
    await markRunFailed(runId, "machine_error");
    return err(502, "machine_error", "failed to reach the workspace machine", true);
  }

  const bundle = await getVersionBundle(deployment.agentVersionId);
  if (!bundle) {
    await markRunFailed(runId, "internal_error");
    return err(500, "internal_error", "agent version bundle is missing", true);
  }

  const input = await req.json().catch(() => ({}));
  const budgets = {
    maxTurnSeconds: deployment.maxTurnSeconds,
    maxStepsPerTurn: deployment.maxStepsPerTurn,
    maxTokensPerRun: deployment.maxTokensPerRun,
  };
  const sessionToken = await mintSession(agent.ownerUserId, info.orgId, undefined, "worker-run", workspace.id);
  const traceUploadUrl = await presignTracePut(runId);

  let machineRes: Response;
  try {
    machineRes = await fetch(`${target.baseUrl}/internal/worker/runs`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${target.agentdToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ runId, bundle, input, budgets, sessionToken, traceUploadUrl, sendId: runId }),
      duplex: "half",
    } as RequestInit & { duplex: "half" });
  } catch (e) {
    console.error(`invoke: machine fetch failed for run ${runId}`, e);
    await markRunFailed(runId, "machine_error");
    return err(502, "machine_error", "failed to reach the workspace machine", true);
  }

  if (!machineRes.ok) {
    const detail = await machineRes.text().catch(() => "");
    console.error(`invoke: machine rejected run ${runId} with status ${machineRes.status}`, detail);
    await markRunFailed(runId, "machine_error");
    return err(502, "machine_error", "workspace machine rejected the run", true);
  }

  await markRunRunning(runId);

  const wait = req.nextUrl.searchParams.get("wait") === "1";
  if (!wait) {
    return new Response(machineRes.body, {
      status: 200,
      headers: {
        "content-type": "application/x-ndjson",
        "cache-control": "no-cache, no-transform",
        "x-content-type-options": "nosniff",
      },
    });
  }

  // Consume the NDJSON stream server-side. The final journal item (kind
  // "end") signals the machine's turn is over, but it does NOT carry the
  // run's output — the worker writes that to the run row out-of-band
  // (Task 6/12). So after the stream ends this polls the row briefly
  // (pollRunSettled) rather than trusting anything parsed from the stream.
  const text = await machineRes.text();
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  let sawEnd = false;
  for (const line of lines) {
    try {
      const item = JSON.parse(line);
      if (item && typeof item === "object" && item.kind === "end") sawEnd = true;
    } catch {
      // Malformed line — the run row is the source of truth for ?wait=1,
      // so this is not fatal.
    }
  }
  if (!sawEnd) {
    console.warn(`invoke: run ${runId} stream ended without a "end" journal item`);
  }

  const row = await pollRunSettled(runId);
  if (!row) {
    return err(500, "internal_error", "run row disappeared after invoke", true);
  }
  return ok({ runId: row.id, status: row.status, output: row.output });
}
