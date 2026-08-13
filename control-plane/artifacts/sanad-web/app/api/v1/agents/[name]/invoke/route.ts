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

/**
 * Best-effort parse of a machine error response body as `{"error":{code,
 * message}}` (the same envelope shape lib/http/envelope.ts's err() emits) —
 * used to tell a genuine 4xx rejection (bad bundle, bad input: the caller's
 * fault, not retryable) apart from a 5xx/network/garbled response (the
 * machine's fault, retryable as machine_error). Returns null for anything
 * that isn't that exact shape, including unparseable JSON.
 */
function parseMachineErrorEnvelope(text: string): { code: string; message: string } | null {
  try {
    const body = JSON.parse(text);
    const code = body?.error?.code;
    const message = body?.error?.message;
    if (typeof code === "string" && typeof message === "string") {
      return { code, message };
    }
  } catch {
    // Not JSON — falls through to the generic machine_error path.
  }
  return null;
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

  // Presign before waking the machine: it's pure config + signing (no
  // machine involved), so failing fast here — instead of after paying for a
  // cold start — avoids a bare, post-wake 500 leaving the run stuck
  // "queued" with a machine already up and nothing to talk to it about.
  let traceUploadUrl: string;
  try {
    traceUploadUrl = await presignTracePut(runId);
  } catch (e) {
    console.error(`invoke: failed to presign trace upload for run ${runId}`, e);
    await markRunFailed(runId, "storage_unconfigured");
    return err(500, "storage_unconfigured", "SANAD_RUNS_BUCKET is not configured");
  }

  let target: MachineTarget;
  try {
    const woken = await wakeMachine(workspace.id, info.env, workspace.keepWarm);
    if (woken === "timeout") {
      // Infra-side failure: clear the idempotency key so a caller retrying
      // with the same Idempotency-Key gets a fresh attempt instead of an
      // eternal replay of this failure (see markRunFailed's docstring).
      await markRunFailed(runId, "wake_timeout", { clearIdempotencyKey: true });
      return machineWakingResponse();
    }
    target = woken;
  } catch (e) {
    console.error(`invoke: failed to wake workspace machine for run ${runId}`, e);
    await markRunFailed(runId, "machine_error", { clearIdempotencyKey: true });
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
    await markRunFailed(runId, "machine_error", { clearIdempotencyKey: true });
    return err(502, "machine_error", "failed to reach the workspace machine", true);
  }

  if (!machineRes.ok) {
    const detail = await machineRes.text().catch(() => "");
    if (machineRes.status >= 400 && machineRes.status < 500) {
      const parsed = parseMachineErrorEnvelope(detail);
      if (parsed) {
        // A 4xx with a parseable envelope is the caller's/bundle's fault
        // (bad input, bad bundle, …), not an infra problem — pass it
        // through verbatim, non-retryable, and keep the idempotency key: a
        // caller fixing their bundle and retrying with the same key should
        // NOT get a fresh run, they should get the same "you did this
        // wrong" answer until they change something (matches genuine
        // run-failure replay semantics, e.g. no_output/budget).
        console.error(
          `invoke: machine rejected run ${runId} with ${machineRes.status} ${parsed.code}`,
          detail
        );
        await markRunFailed(runId, parsed.code);
        return err(machineRes.status, parsed.code, parsed.message);
      }
    }
    // 5xx, network-shaped, or an unparseable body — machine's fault, not the
    // caller's; infra failure, so clear the idempotency key too.
    console.error(`invoke: machine rejected run ${runId} with status ${machineRes.status}`, detail);
    await markRunFailed(runId, "machine_error", { clearIdempotencyKey: true });
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
