import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Concurrent wakes of one session must produce ONE RunTask. Three terminal
 * panels plus the drawer all mount at once — before the in-flight lock, each
 * raced its own machine into existence with last-writer-wins nonces.
 */

const runCalls: unknown[] = [];
let taskState = "STOPPED";

vi.mock("@/lib/compute/aws", () => ({
  awsComputeConfig: () => ({
    region: "eu-central-1",
    cluster: "test",
    subnets: ["s-1"],
    tasksSecurityGroup: "sg-1",
    efsId: "fs-1",
    workspaceImage: "img:latest",
    executionRoleArn: "arn:exec",
    taskRoleArn: "arn:task",
    logGroup: "/test",
    controlPlaneUrl: "https://cp.test",
    allowedOrigins: "https://cp.test",
  }),
  describeTask: vi.fn(async () => ({
    status: taskState,
    privateIp: taskState === "RUNNING" ? "10.0.0.9" : null,
    imageDigest: "sha256:abc",
  })),
  latestWorkspaceImageDigest: vi.fn(async () => "sha256:abc"),
  ensureAccessPoint: vi.fn(async () => "fsap-1"),
  registerTaskDefinition: vi.fn(async () => "arn:taskdef"),
  runWorkspaceTask: vi.fn(async (_config: unknown, _def: unknown, env: unknown) => {
    runCalls.push(env);
    taskState = "RUNNING";
    return "arn:run-1";
  }),
  stopTask: vi.fn(async () => {}),
}));

const row = {
  id: "sess-1",
  userId: "user_1",
  name: "main",
  hash12: "abc123def456",
  efsAccessPointId: "fsap-1",
  taskArn: null as string | null,
  taskIp: null as string | null,
  runNonce: null as string | null,
  imageRef: "img:latest",
  state: "provisioning",
};

vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [row],
          orderBy: async () => [row],
        }),
        orderBy: () => ({ where: () => ({ limit: async () => [row] }) }),
      }),
    }),
    update: () => ({ set: () => ({ where: async () => [] }) }),
  },
}));

beforeEach(() => {
  vi.stubEnv("TERMINAL_MACHINE_KEY", "test-key");
  runCalls.length = 0;
  taskState = "STOPPED";
  row.taskArn = null;
  row.runNonce = null;
  // agentd healthz answers as soon as the machine "runs"
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify({ status: "ok", activeSessions: 0, detachedSessions: 0 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    )
  );
});

describe("ensureSessionTask concurrency", () => {
  it("serializes concurrent wakes into one RunTask", async () => {
    const { ensureSessionTask } = await import("@/lib/compute/sessions");
    const [a, b, c] = await Promise.all([
      ensureSessionTask("user_1", "sess-1"),
      ensureSessionTask("user_1", "sess-1"),
      ensureSessionTask("user_1", "sess-1"),
    ]);
    expect(runCalls.length).toBe(1);
    // All callers share the machine AND its credential — no nonce churn.
    expect(a.agentdToken).toBe(b.agentdToken);
    expect(b.agentdToken).toBe(c.agentdToken);
    expect(a.hash12).toBe("abc123def456");
  });
});
