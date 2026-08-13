/**
 * Runs: the store behind the sync invoke route
 * (app/api/v1/agents/[name]/invoke/route.ts). Owns run-row lifecycle
 * (create/idempotent-replay/status transitions) and the S3 presigned URLs the
 * machine uses to upload/read a run's wire trace.
 */
import { randomBytes } from "crypto";
import { and, desc, eq, getTableColumns, inArray } from "drizzle-orm";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { db } from "../db";
import { agents, deployments, runs, workspaces } from "../db/schema";
import { MODEL_PRICING } from "../models/catalog";

export type RunRow = typeof runs.$inferSelect;

export type GateResult =
  | { ok: true }
  | { ok: false; status: number; code: string; message: string };

/**
 * Pure decision core for the invoke route's access gate: is this token
 * allowed to invoke this agent, and is there a live, unpaused deployment to
 * run against? Extracted so the three failure branches (token scope,
 * never-deployed, paused) are testable without touching Next or the DB.
 */
export function invokeGate(p: {
  tokenAgentId: string;
  pathAgentId: string;
  deployment: { status: string } | null;
}): GateResult {
  if (p.tokenAgentId !== p.pathAgentId)
    return { ok: false, status: 403, code: "token_scope", message: "token is for another agent" };
  if (!p.deployment)
    return { ok: false, status: 404, code: "not_deployed", message: "no active deployment for env" };
  if (p.deployment.status === "paused")
    return { ok: false, status: 409, code: "paused", message: "deployment is paused" };
  return { ok: true };
}

export function newRunId(): string {
  return "r_" + randomBytes(6).toString("hex");
}

/**
 * Create a run row, or — if an Idempotency-Key was supplied and a run
 * already exists for this (deploymentId, idempotencyKey) pair
 * (runs_deployment_idem_uq) — return the existing one instead. A NULL
 * idempotencyKey never conflicts (Postgres treats NULLs as distinct in a
 * unique index), so unkeyed invokes always insert a fresh row.
 */
export async function createRun(p: {
  deploymentId: string;
  agentVersionId: string;
  triggerPrincipal: string;
  idempotencyKey?: string;
}): Promise<{ id: string; existing: boolean }> {
  const id = newRunId();
  const idempotencyKey = p.idempotencyKey ?? null;

  const inserted = await db
    .insert(runs)
    .values({
      id,
      deploymentId: p.deploymentId,
      agentVersionId: p.agentVersionId,
      triggerPrincipal: p.triggerPrincipal,
      idempotencyKey,
    })
    .onConflictDoNothing({ target: [runs.deploymentId, runs.idempotencyKey] })
    .returning({ id: runs.id });

  if (inserted[0]) {
    return { id: inserted[0].id, existing: false };
  }

  // Conflicted: idempotencyKey was non-null and already used for this
  // deployment (see the NULL note above — this branch is unreachable
  // otherwise). Re-select the row that won the race.
  const existingRows = await db
    .select()
    .from(runs)
    .where(and(eq(runs.deploymentId, p.deploymentId), eq(runs.idempotencyKey, idempotencyKey as string)))
    .limit(1);
  const existing = existingRows[0];
  if (!existing) {
    throw new Error("createRun: insert conflicted but no existing row was found");
  }
  return { id: existing.id, existing: true };
}

export async function getRun(id: string): Promise<RunRow | null> {
  const rows = await db.select().from(runs).where(eq(runs.id, id)).limit(1);
  return rows[0] ?? null;
}

/**
 * Flip a queued run to "running". Guarded to only match status="queued" —
 * without this, a fast completion POST (or the reaper) landing before this
 * UPDATE runs could resurrect an already-terminal ("succeeded"/"failed"/
 * "lost") row back to "running" forever, since an unconditional UPDATE by id
 * has no way to know the row moved on in the meantime.
 */
export async function markRunRunning(id: string): Promise<void> {
  await db
    .update(runs)
    .set({ status: "running", startedAt: new Date() })
    .where(and(eq(runs.id, id), eq(runs.status, "queued")));
}

/**
 * Flip a run to "failed". `clearIdempotencyKey` should be set true only for
 * infra-side failures (wake_timeout, machine_error) — a caller retrying with
 * the same Idempotency-Key after those must get a fresh attempt, not an
 * eternal replay of `{status:"failed"}` (createRun's onConflictDoNothing
 * replays by (deploymentId, idempotencyKey), so a poisoned key can never
 * succeed again). Genuine run failures (no_output, budget) keep their key —
 * replaying "failed" for those is the correct, intended behavior.
 */
export async function markRunFailed(
  id: string,
  errorCode: string,
  opts?: { clearIdempotencyKey?: boolean }
): Promise<void> {
  await db
    .update(runs)
    .set({
      status: "failed",
      errorCode,
      finishedAt: new Date(),
      ...(opts?.clearIdempotencyKey ? { idempotencyKey: null } : {}),
    })
    .where(eq(runs.id, id));
}

/**
 * USD cost of a run's token usage, in micros (1 USD = 1_000_000 micros — the
 * unit `runs.cost_usd_micros` is stored in). An alias missing from
 * MODEL_PRICING (unpriced/experimental model, or null when the machine never
 * reported one) costs 0 rather than throwing — pricing gaps must never block
 * a run from completing.
 *
 * Note the cancellation: tokens/1e6 * usdPerMTok * 1e6micros = tokens *
 * usdPerMTok — the 1e6s cancel, so this is just tokens * usdPerMTok with no
 * division at all. Kept as a comment because the lack of any `/1e6` in the
 * code reads like a bug without it.
 */
export function costUsdMicros(
  alias: string | null,
  tokensIn: number,
  tokensOut: number
): number {
  const p = alias ? MODEL_PRICING[alias] : undefined;
  if (!p) return 0;
  return Math.round(tokensIn * p.inUsdPerMTok + tokensOut * p.outUsdPerMTok);
}

/**
 * Flip a run to its terminal state — the machine's out-of-band completion
 * report (POST .../runs/{id}/complete), consumed by the invoke route's
 * ?wait=1 poll (pollRunSettled) and the read APIs. A single conditional
 * UPDATE (status IN ("queued","running") in the WHERE clause, not a
 * separate SELECT beforehand) so the flip is atomic: completing a run
 * that's already left "queued"/"running" (retried completion POST, or one
 * that lands after the reaper already marked the run "lost") is a no-op —
 * zero rows match and nothing is clobbered. Callers that need the
 * post-call status (the route's `{runId, status}` response) re-read the row
 * with getRun after calling this.
 */
export async function completeRun(
  runId: string,
  p: {
    status: "succeeded" | "failed" | "cancelled";
    errorCode?: string;
    output?: unknown;
    tokensIn: number;
    tokensOut: number;
    modelAlias?: string;
    traceUploaded: boolean;
  }
): Promise<void> {
  const modelAlias = p.modelAlias ?? null;
  await db
    .update(runs)
    .set({
      status: p.status,
      errorCode: p.errorCode ?? null,
      output: p.output ?? null,
      tokensIn: p.tokensIn,
      tokensOut: p.tokensOut,
      modelAlias,
      costUsdMicros: costUsdMicros(modelAlias, p.tokensIn, p.tokensOut),
      traceUploaded: p.traceUploaded,
      finishedAt: new Date(),
    })
    .where(and(eq(runs.id, runId), inArray(runs.status, ["queued", "running"])));
}

// -- read APIs ------------------------------------------------------------
// Every read below joins runs -> deployments -> agents -> workspaces and
// filters on workspaces.orgId — the established information-hiding rule
// (see lib/agents/registry.ts's getAgentByName): a run id belonging to
// another org must 404 exactly like one that doesn't exist at all, never
// leak via a 403.

/** JSON-safe projection of a run row for the read APIs. */
export function serializeRun(row: RunRow) {
  return {
    id: row.id,
    deploymentId: row.deploymentId,
    agentVersionId: row.agentVersionId,
    status: row.status,
    errorCode: row.errorCode,
    triggerPrincipal: row.triggerPrincipal,
    output: row.output,
    tokensIn: row.tokensIn,
    tokensOut: row.tokensOut,
    costUsdMicros: row.costUsdMicros,
    modelAlias: row.modelAlias,
    traceUploaded: row.traceUploaded,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    createdAt: row.createdAt,
  };
}

/** A single run, scoped to the org — a foreign or unknown run id both return null. */
export async function getRunForOrg(runId: string, orgId: string): Promise<RunRow | null> {
  const rows = await db
    .select(getTableColumns(runs))
    .from(runs)
    .innerJoin(deployments, eq(runs.deploymentId, deployments.id))
    .innerJoin(agents, eq(deployments.agentId, agents.id))
    .innerJoin(workspaces, eq(agents.workspaceId, workspaces.id))
    .where(and(eq(runs.id, runId), eq(workspaces.orgId, orgId)))
    .limit(1);
  return rows[0] ?? null;
}

/** Org-scoped run list for `GET /api/v1/runs`, newest-first. */
export async function listRuns(p: {
  orgId: string;
  agentId?: string;
  env?: string;
  status?: string;
  limit: number;
}): Promise<RunRow[]> {
  const conditions = [eq(workspaces.orgId, p.orgId)];
  if (p.agentId) conditions.push(eq(agents.id, p.agentId));
  if (p.env) conditions.push(eq(deployments.env, p.env));
  if (p.status) conditions.push(eq(runs.status, p.status));

  return db
    .select(getTableColumns(runs))
    .from(runs)
    .innerJoin(deployments, eq(runs.deploymentId, deployments.id))
    .innerJoin(agents, eq(deployments.agentId, agents.id))
    .innerJoin(workspaces, eq(agents.workspaceId, workspaces.id))
    .where(and(...conditions))
    .orderBy(desc(runs.createdAt))
    .limit(p.limit);
}

// -- trace presigner ----------------------------------------------------
// Lazy client, like lib/compute/aws.ts's clients — railway mode never
// touches AWS, so nothing here should construct a client at import time.
let s3: S3Client | null = null;
const bucket = () => {
  const b = process.env.SANAD_RUNS_BUCKET;
  if (!b) throw new Error("SANAD_RUNS_BUCKET is not configured");
  return b;
};
const client = () => (s3 ??= new S3Client({ region: process.env.AWS_REGION ?? "eu-central-1" }));

export const traceKey = (runId: string) => `runs/${runId}/wire.jsonl.gz`;

export function presignTracePut(runId: string): Promise<string> {
  return getSignedUrl(client(), new PutObjectCommand({ Bucket: bucket(), Key: traceKey(runId) }), {
    expiresIn: 3600,
  });
}

export function presignTraceGet(runId: string): Promise<string> {
  return getSignedUrl(client(), new GetObjectCommand({ Bucket: bucket(), Key: traceKey(runId) }), {
    expiresIn: 300,
  });
}
