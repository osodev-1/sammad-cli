import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/tokens/invoke", () => ({ verifyInvokeBearer: vi.fn() }));
vi.mock("@/lib/agents/registry", () => ({
  getAgentByName: vi.fn(),
  getLiveDeployment: vi.fn(),
  getVersionBundle: vi.fn(),
  getWorkspaceById: vi.fn(),
}));
// assertWithinQuota is real business logic that reaches the db on the
// non-mocked path — no route test case here exercises quota rejection, but
// the route calls it unconditionally, so it still needs a resolved stub.
vi.mock("@/lib/billing/quota", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/billing/quota")>();
  return { ...actual, assertWithinQuota: vi.fn() };
});
vi.mock("@/lib/compute/machines", () => ({ ensureWorkspaceMachine: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ mintSession: vi.fn() }));
// invokeGate/newRunId are pure (no db) — keep them real so the 403/404/409
// gate-priority logic under test is the actual implementation, not a
// hand-rolled stand-in that could drift from it.
vi.mock("@/lib/runs/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/runs/store")>();
  return {
    ...actual,
    createRun: vi.fn(),
    getRun: vi.fn(),
    markRunFailed: vi.fn(),
    markRunRunning: vi.fn(),
    presignTracePut: vi.fn(),
  };
});

import { verifyInvokeBearer } from "@/lib/tokens/invoke";
import { getAgentByName, getLiveDeployment, getVersionBundle, getWorkspaceById } from "@/lib/agents/registry";
import { assertWithinQuota } from "@/lib/billing/quota";
import { ensureWorkspaceMachine } from "@/lib/compute/machines";
import { mintSession } from "@/lib/auth/session";
import { createRun, getRun, markRunFailed, presignTracePut } from "@/lib/runs/store";
import { POST } from "@/app/api/v1/agents/[name]/invoke/route";

const TOKEN_INFO = { tokenId: "tok_1", agentId: "ag_1", env: "prod", orgId: "org_1" };
const AGENT = { id: "ag_1", workspaceId: "ws_1", ownerUserId: "user_1", name: "invoice-triage" };
const DEPLOYMENT = {
  id: "dp_1",
  agentId: "ag_1",
  agentVersionId: "av_1",
  env: "prod",
  status: "active",
  maxTurnSeconds: 900,
  maxStepsPerTurn: 100,
  maxTokensPerRun: 2_000_000,
};
const WORKSPACE = { id: "ws_1", keepWarm: false };
const MACHINE_TARGET = {
  machineId: "wm_1",
  hash12: "abc123def456",
  baseUrl: "http://10.0.0.9:4100",
  agentdToken: "agentd-tok",
  coldStart: false,
};

function req(opts: { bearer?: string | null; body?: unknown; wait?: boolean } = {}): NextRequest {
  const bearer = "bearer" in opts ? opts.bearer : "itok_abc";
  const body = opts.body ?? {};
  const qs = opts.wait ? "?wait=1" : "";
  return new NextRequest(`http://localhost/api/v1/agents/invoice-triage/invoke${qs}`, {
    method: "POST",
    headers: {
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function ctx(name = "invoice-triage") {
  return { params: Promise.resolve({ name }) };
}

/** Wires the happy-path chain through workspace resolution — individual
 * tests override whichever mock they need to diverge on. */
function mockHappyPathThroughGate() {
  vi.mocked(verifyInvokeBearer).mockResolvedValue(TOKEN_INFO);
  vi.mocked(getAgentByName).mockResolvedValue(AGENT as never);
  vi.mocked(getLiveDeployment).mockResolvedValue(DEPLOYMENT as never);
  vi.mocked(assertWithinQuota).mockResolvedValue(undefined);
  vi.mocked(getWorkspaceById).mockResolvedValue(WORKSPACE as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn());
});

describe("POST /api/v1/agents/[name]/invoke", () => {
  it("401s with no itok", async () => {
    vi.mocked(verifyInvokeBearer).mockResolvedValue(null);

    const res = await POST(req({ bearer: null }), ctx());

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("unauthorized");
    expect(getAgentByName).not.toHaveBeenCalled();
  });

  it("403s token_scope for a cross-agent token", async () => {
    vi.mocked(verifyInvokeBearer).mockResolvedValue(TOKEN_INFO);
    // The path agent ("ag_2") doesn't match the token's agentId ("ag_1").
    vi.mocked(getAgentByName).mockResolvedValue({ ...AGENT, id: "ag_2" } as never);
    vi.mocked(getLiveDeployment).mockResolvedValue(DEPLOYMENT as never);

    const res = await POST(req(), ctx());

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("token_scope");
    // Token-scope outranks quota — the route must reject before even
    // checking quota.
    expect(assertWithinQuota).not.toHaveBeenCalled();
    expect(createRun).not.toHaveBeenCalled();
  });

  it("404s not_deployed when there is no live deployment for the env", async () => {
    mockHappyPathThroughGate();
    vi.mocked(getLiveDeployment).mockResolvedValue(null as never);

    const res = await POST(req(), ctx());

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("not_deployed");
    expect(createRun).not.toHaveBeenCalled();
  });

  it("409s paused for a paused deployment", async () => {
    mockHappyPathThroughGate();
    vi.mocked(getLiveDeployment).mockResolvedValue({ ...DEPLOYMENT, status: "paused" } as never);

    const res = await POST(req(), ctx());

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("paused");
    expect(createRun).not.toHaveBeenCalled();
  });

  it("replays an idempotent invoke without ever calling the machine", async () => {
    mockHappyPathThroughGate();
    vi.mocked(createRun).mockResolvedValue({ id: "r_1", existing: true });
    vi.mocked(getRun).mockResolvedValue({
      id: "r_1",
      status: "succeeded",
      output: { text: "cached result" },
    } as never);

    const res = await POST(req({ body: {} }), ctx());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ runId: "r_1", status: "succeeded", output: { text: "cached result" } });
    expect(ensureWorkspaceMachine).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(getWorkspaceById).not.toHaveBeenCalled();
  });

  it("passes through a machine 400 as non-retryable (Finding 3)", async () => {
    mockHappyPathThroughGate();
    vi.mocked(createRun).mockResolvedValue({ id: "r_1", existing: false });
    vi.mocked(presignTracePut).mockResolvedValue("https://s3.example/put");
    vi.mocked(ensureWorkspaceMachine).mockResolvedValue(MACHINE_TARGET as never);
    vi.mocked(getVersionBundle).mockResolvedValue({ files: {} });
    vi.mocked(mintSession).mockResolvedValue("session-tok" as never);
    vi.mocked(global.fetch).mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "bad_bundle", message: "bundle failed to parse" } }), {
        status: 400,
      }) as never
    );

    const res = await POST(req(), ctx());

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatchObject({ code: "bad_bundle", message: "bundle failed to parse", retryable: false });
    expect(markRunFailed).toHaveBeenCalledWith("r_1", "bad_bundle");
  });

  it("500s storage_unconfigured before ever waking the machine (Finding 8)", async () => {
    mockHappyPathThroughGate();
    vi.mocked(createRun).mockResolvedValue({ id: "r_1", existing: false });
    vi.mocked(presignTracePut).mockRejectedValue(new Error("SANAD_RUNS_BUCKET is not configured"));

    const res = await POST(req(), ctx());

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe("storage_unconfigured");
    expect(ensureWorkspaceMachine).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(markRunFailed).toHaveBeenCalledWith("r_1", "storage_unconfigured");
  });
});
