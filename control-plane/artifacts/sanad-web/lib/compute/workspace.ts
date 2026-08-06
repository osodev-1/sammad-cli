/**
 * ensureWorkspaceTask: the per-user machine lifecycle state machine.
 *
 * First session: EFS access point → task definition (embeds the AP) → RunTask
 * with a fresh nonce-derived credential → wait RUNNING → publish the task IP
 * for the router → health-poll agentd THROUGH the router (sanad-web cannot
 * reach task-private IPs from Railway) → ready.
 *
 * Later sessions: reuse the running task, or re-run it (new nonce, new IP)
 * after an idle self-stop. The ticket is minted by the CALLER only after this
 * returns, so its 60s TTL is spent on the browser's connect — never on a cold
 * start.
 */
import { eq } from "drizzle-orm";
import { db } from "../db";
import { workspaceTasks } from "../db/schema";
import {
  awsComputeConfig,
  describeTask,
  ensureAccessPoint,
  registerTaskDefinition,
  runWorkspaceTask,
  type AwsComputeConfig,
} from "./aws";
import { deriveMachineToken, workspaceHash } from "./tokens";

const RUN_POLL_MS = 2_000;
const RUN_TIMEOUT_MS = 120_000;
const HEALTH_TIMEOUT_MS = 60_000;

export interface WorkspaceTarget {
  hash12: string;
  wsUrl: string;
  baseUrl: string; // https://compute.../u/<hash12>
  agentdToken: string;
  coldStart: boolean;
}

export function computeBaseUrl(hash12: string): string {
  const host = process.env.COMPUTE_HOST ?? "compute.sanadcode.com";
  return `https://${host}/u/${hash12}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

export async function ensureWorkspaceTask(userId: string): Promise<WorkspaceTarget> {
  const config = awsComputeConfig();
  const hash12 = workspaceHash(userId);

  let [row] = await db
    .select()
    .from(workspaceTasks)
    .where(eq(workspaceTasks.userId, userId))
    .limit(1);

  if (!row) {
    const accessPointId = await ensureAccessPoint(config, hash12);
    const inserted = await db
      .insert(workspaceTasks)
      .values({
        id: crypto.randomUUID(),
        userId,
        hash12,
        efsAccessPointId: accessPointId,
        imageRef: config.workspaceImage,
        state: "provisioning",
      })
      .onConflictDoNothing({ target: workspaceTasks.userId })
      .returning();
    if (inserted.length > 0) {
      row = inserted[0];
    } else {
      // Concurrent provision — take the winner's row.
      [row] = await db
        .select()
        .from(workspaceTasks)
        .where(eq(workspaceTasks.userId, userId))
        .limit(1);
    }
  }

  const baseUrl = computeBaseUrl(row.hash12);

  // A recorded task may still be running (warm attach) …
  if (row.taskArn && row.runNonce) {
    const { status, privateIp } = await describeTask(config, row.taskArn);
    if (status === "RUNNING" && privateIp) {
      if (privateIp !== row.taskIp) {
        await db
          .update(workspaceTasks)
          .set({ taskIp: privateIp, updatedAt: new Date() })
          .where(eq(workspaceTasks.id, row.id));
      }
      return {
        hash12: row.hash12,
        wsUrl: `${baseUrl.replace("https://", "wss://")}/ws`,
        baseUrl,
        agentdToken: deriveMachineToken(userId, row.runNonce),
        coldStart: false,
      };
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
      .update(workspaceTasks)
      .set({
        taskArn,
        taskIp: privateIp,
        runNonce,
        imageRef: config.workspaceImage,
        state: "ready",
        lastSeenAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(workspaceTasks.id, row.id));
    await waitForAgentd(baseUrl);
  } catch (e) {
    await db
      .update(workspaceTasks)
      .set({ state: "error", updatedAt: new Date() })
      .where(eq(workspaceTasks.id, row.id));
    throw e;
  }

  return {
    hash12: row.hash12,
    wsUrl: `${baseUrl.replace("https://", "wss://")}/ws`,
    baseUrl,
    agentdToken,
    coldStart: true,
  };
}

/** Auth material for proxying workspace REST to a (hopefully) running task. */
export async function workspaceTaskAuth(
  userId: string
): Promise<{ baseUrl: string; token: string } | null> {
  const [row] = await db
    .select()
    .from(workspaceTasks)
    .where(eq(workspaceTasks.userId, userId))
    .limit(1);
  if (!row?.runNonce) return null;
  return {
    baseUrl: computeBaseUrl(row.hash12),
    token: deriveMachineToken(userId, row.runNonce),
  };
}
