/**
 * Workspace sessions: each session is a project with its own machine.
 *
 * A session owns an EFS access point (its private directory tree), a Fargate
 * task (started on demand, self-stopped when idle — zero compute cost while
 * asleep), and therefore its own agent conversation history (the CLI keys
 * history by working directory). ensureSessionTask is the same verified state
 * machine that ran the per-user workspace, keyed per session.
 */
import { and, asc, eq } from "drizzle-orm";
import { db } from "../db";
import { workspaceSessions } from "../db/schema";
import {
  awsComputeConfig,
  describeTask,
  ensureAccessPoint,
  registerTaskDefinition,
  runWorkspaceTask,
  stopTask,
  type AwsComputeConfig,
} from "./aws";
import { deriveMachineToken, sessionHash } from "./tokens";

const RUN_POLL_MS = 2_000;
const RUN_TIMEOUT_MS = 120_000;
const HEALTH_TIMEOUT_MS = 60_000;

/** Dogfood guardrail — each awake session is its own billed task. */
export const MAX_SESSIONS_PER_USER = 5;

export type SessionRow = typeof workspaceSessions.$inferSelect;

export interface SessionTarget {
  sessionId: string;
  hash12: string;
  wsUrl: string;
  baseUrl: string;
  agentdToken: string;
  coldStart: boolean;
}

export function computeBaseUrl(hash12: string): string {
  const host = process.env.COMPUTE_HOST ?? "compute.sanadcode.com";
  return `https://${host}/u/${hash12}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function probeHealthz(url: string, timeoutMs = 3_000): Promise<boolean> {
  try {
    const res = await fetch(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForRunning(
  config: AwsComputeConfig,
  taskArn: string
): Promise<string> {
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const { status, privateIp } = await describeTask(config, taskArn);
    if (status === "RUNNING" && privateIp) return privateIp;
    if (status === "STOPPED" || status === "MISSING") {
      throw new Error(`workspace task ${status.toLowerCase()} during startup`);
    }
    await sleep(RUN_POLL_MS);
  }
  throw new Error("workspace task did not reach RUNNING in time");
}

async function waitForAgentd(baseUrl: string): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/healthz`, { cache: "no-store" });
      if (res.ok) return;
      lastError = `healthz ${res.status}`;
    } catch (e) {
      lastError = e instanceof Error ? e.message : "fetch failed";
    }
    await sleep(RUN_POLL_MS);
  }
  throw new Error(`agentd never became healthy: ${lastError}`);
}

function agentBaseEnv(config: AwsComputeConfig, userId: string): Record<string, string> {
  return {
    WORKSPACE_MODE: "task",
    SANAD_WORKSPACE_USER: userId,
    CONTROL_PLANE_URL: config.controlPlaneUrl,
    SANAD_API_BASE_URL: config.controlPlaneUrl,
    TERMINAL_ALLOWED_ORIGINS: config.allowedOrigins,
  };
}

/* ------------------------------------------------------------- sessions --- */

export async function listSessions(userId: string): Promise<SessionRow[]> {
  return db
    .select()
    .from(workspaceSessions)
    .where(eq(workspaceSessions.userId, userId))
    .orderBy(asc(workspaceSessions.createdAt));
}

export async function getSession(
  userId: string,
  sessionId: string
): Promise<SessionRow | null> {
  const [row] = await db
    .select()
    .from(workspaceSessions)
    .where(
      and(eq(workspaceSessions.userId, userId), eq(workspaceSessions.id, sessionId))
    )
    .limit(1);
  return row ?? null;
}

/**
 * The user's default session. Existing single-workspace users were migrated
 * to a "main" session (same hash, same access point — nothing moved); a brand
 * new user gets one created on first touch.
 */
export async function getOrCreateMainSession(userId: string): Promise<SessionRow> {
  const rows = await listSessions(userId);
  if (rows.length > 0) return rows[0];
  return createSession(userId, "main");
}

export async function createSession(userId: string, name: string): Promise<SessionRow> {
  const existing = await listSessions(userId);
  if (existing.length >= MAX_SESSIONS_PER_USER) {
    throw Object.assign(new Error("session limit reached"), { code: "session_limit" });
  }
  const config = awsComputeConfig();
  const id = crypto.randomUUID();
  const hash12 = sessionHash(userId, id);
  const accessPointId = await ensureAccessPoint(config, hash12);
  const [row] = await db
    .insert(workspaceSessions)
    .values({
      id,
      userId,
      name: name.trim().slice(0, 40) || "untitled",
      hash12,
      efsAccessPointId: accessPointId,
      imageRef: config.workspaceImage,
      state: "provisioning",
    })
    .returning();
  return row;
}

export async function renameSession(
  userId: string,
  sessionId: string,
  name: string
): Promise<SessionRow | null> {
  const [row] = await db
    .update(workspaceSessions)
    .set({ name: name.trim().slice(0, 40) || "untitled", updatedAt: new Date() })
    .where(
      and(eq(workspaceSessions.userId, userId), eq(workspaceSessions.id, sessionId))
    )
    .returning();
  return row ?? null;
}

/* ------------------------------------------------------- machine control --- */

/** Ensure the session's machine is running and reachable; wake it if not. */
export async function ensureSessionTask(
  userId: string,
  sessionId: string
): Promise<SessionTarget> {
  const config = awsComputeConfig();
  const row = await getSession(userId, sessionId);
  if (!row) throw Object.assign(new Error("unknown session"), { code: "unknown_session" });

  const baseUrl = computeBaseUrl(row.hash12);

  // A recorded task may still be running (warm attach) …
  if (row.taskArn && row.runNonce) {
    const { status, privateIp } = await describeTask(config, row.taskArn);
    if (status === "RUNNING" && privateIp) {
      if (privateIp !== row.taskIp) {
        await db
          .update(workspaceSessions)
          .set({ taskIp: privateIp, updatedAt: new Date() })
          .where(eq(workspaceSessions.id, row.id));
      }
      // "RUNNING" at ECS is not "reachable": verify agentd answers through
      // the router — the same path the browser is about to use.
      if (await probeHealthz(`${baseUrl}/healthz`)) {
        return {
          sessionId: row.id,
          hash12: row.hash12,
          wsUrl: `${baseUrl.replace("https://", "wss://")}/ws`,
          baseUrl,
          agentdToken: deriveMachineToken(userId, row.runNonce),
          coldStart: false,
        };
      }
      // Unreachable. If the ingress itself is down, the task is likely fine —
      // never stop it (it may be mid-task); surface a retryable error instead.
      const host = process.env.COMPUTE_HOST ?? "compute.sanadcode.com";
      if (!(await probeHealthz(`https://${host}/healthz`))) {
        throw new Error("compute ingress is unavailable — retry shortly");
      }
      console.error(`session task ${row.taskArn} is RUNNING but unreachable — replacing`);
      await stopTask(config, row.taskArn).catch(() => {});
    }
  }

  // … otherwise (never ran / self-stopped / died): fresh run, fresh nonce.
  const runNonce = crypto.randomUUID();
  const agentdToken = deriveMachineToken(userId, runNonce);
  const taskDefArn = await registerTaskDefinition(
    config,
    row.hash12,
    row.efsAccessPointId,
    agentBaseEnv(config, userId)
  );
  const taskArn = await runWorkspaceTask(config, taskDefArn, {
    AGENTD_TOKEN: agentdToken,
    MACHINE_NONCE: runNonce,
  });

  try {
    const privateIp = await waitForRunning(config, taskArn);
    // Publish the route BEFORE health-polling: the poll goes through the router.
    await db
      .update(workspaceSessions)
      .set({
        taskArn,
        taskIp: privateIp,
        runNonce,
        imageRef: config.workspaceImage,
        state: "ready",
        lastSeenAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(workspaceSessions.id, row.id));
    await waitForAgentd(baseUrl);
  } catch (e) {
    await db
      .update(workspaceSessions)
      .set({ state: "error", updatedAt: new Date() })
      .where(eq(workspaceSessions.id, row.id));
    throw e;
  }

  return {
    sessionId: row.id,
    hash12: row.hash12,
    wsUrl: `${baseUrl.replace("https://", "wss://")}/ws`,
    baseUrl,
    agentdToken,
    coldStart: true,
  };
}

/** Auth material for proxying workspace REST to a (hopefully) running session machine. */
export async function sessionTaskAuth(
  userId: string,
  sessionId?: string
): Promise<{ baseUrl: string; token: string } | null> {
  const row = sessionId
    ? await getSession(userId, sessionId)
    : (await listSessions(userId))[0] ?? null;
  if (!row?.runNonce) return null;
  return {
    baseUrl: computeBaseUrl(row.hash12),
    token: deriveMachineToken(userId, row.runNonce),
  };
}

/** Router route lookup: hash12 → task IP (sessions first, legacy table second). */
export async function sessionIpByHash(hash12: string): Promise<string | null> {
  const [row] = await db
    .select({ taskIp: workspaceSessions.taskIp })
    .from(workspaceSessions)
    .where(eq(workspaceSessions.hash12, hash12))
    .limit(1);
  return row?.taskIp ?? null;
}
