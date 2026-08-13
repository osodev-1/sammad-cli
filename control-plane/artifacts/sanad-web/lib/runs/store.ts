/**
 * Runs: the store behind the sync invoke route
 * (app/api/v1/agents/[name]/invoke/route.ts). Owns run-row lifecycle
 * (create/idempotent-replay/status transitions) and the S3 presigned URLs the
 * machine uses to upload/read a run's wire trace.
 */
import { randomBytes } from "crypto";
import { and, eq } from "drizzle-orm";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { db } from "../db";
import { runs } from "../db/schema";

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

export async function markRunRunning(id: string): Promise<void> {
  await db
    .update(runs)
    .set({ status: "running", startedAt: new Date() })
    .where(eq(runs.id, id));
}

export async function markRunFailed(id: string, errorCode: string): Promise<void> {
  await db
    .update(runs)
    .set({ status: "failed", errorCode, finishedAt: new Date() })
    .where(eq(runs.id, id));
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
