import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/runs/store", () => ({
  completeRun: vi.fn(),
  getRun: vi.fn(),
}));
vi.mock("@/lib/agents/registry", () => ({
  getAgentById: vi.fn(),
  getDeploymentById: vi.fn(),
  getWorkspaceById: vi.fn(),
}));
vi.mock("@/lib/compute/machines", () => ({
  getMachineByWorkspaceEnv: vi.fn(),
  touchMachineLastSeen: vi.fn(),
}));
vi.mock("@/lib/compute/tokens", () => ({
  machineTokenMatches: vi.fn(),
}));

import { completeRun, getRun } from "@/lib/runs/store";
import { getAgentById, getDeploymentById, getWorkspaceById } from "@/lib/agents/registry";
import { getMachineByWorkspaceEnv, touchMachineLastSeen } from "@/lib/compute/machines";
import { machineTokenMatches } from "@/lib/compute/tokens";
import { POST } from "@/app/api/v1/runs/[id]/complete/route";

const RUN = { id: "r_1", deploymentId: "dp_1", status: "running" };
const DEPLOYMENT = { id: "dp_1", agentId: "ag_1", env: "prod" };
const AGENT = { id: "ag_1", workspaceId: "ws_1" };
const WORKSPACE = { id: "ws_1" };
const MACHINE = { id: "wm_1", workspaceId: "ws_1", env: "prod", runNonce: "nonce-1" };

const VALID_BODY = {
  status: "succeeded" as const,
  output: { text: "done" },
  tokensIn: 100,
  tokensOut: 50,
  modelAlias: "kimi-k3",
  traceUploaded: true,
};

function req(opts: { bearer?: string | null; body?: unknown } = {}): NextRequest {
  // "bearer" absent from opts -> default token; explicit `bearer: null` ->
  // no Authorization header at all (distinct from JS's destructuring
  // default, which can't tell "key omitted" from "key set to undefined").
  const bearer = "bearer" in opts ? opts.bearer : "correct-token";
  const body = opts.body ?? VALID_BODY;
  return new NextRequest("http://localhost/api/v1/runs/r_1/complete", {
    method: "POST",
    headers: {
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function ctx(id = "r_1") {
  return { params: Promise.resolve({ id }) };
}

function mockFullChain() {
  vi.mocked(getRun).mockResolvedValue(RUN as never);
  vi.mocked(getDeploymentById).mockResolvedValue(DEPLOYMENT as never);
  vi.mocked(getAgentById).mockResolvedValue(AGENT as never);
  vi.mocked(getWorkspaceById).mockResolvedValue(WORKSPACE as never);
  vi.mocked(getMachineByWorkspaceEnv).mockResolvedValue(MACHINE as never);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/v1/runs/[id]/complete", () => {
  it("401s with a wrong bearer (machine credential doesn't match)", async () => {
    mockFullChain();
    vi.mocked(machineTokenMatches).mockReturnValue(false);

    const res = await POST(req({ bearer: "wrong-token" }), ctx());

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("unauthorized");
    expect(completeRun).not.toHaveBeenCalled();
    // Auth never succeeded — the staleness signal must not be touched for a
    // credential that didn't check out.
    expect(touchMachineLastSeen).not.toHaveBeenCalled();
  });

  it("401s with no Authorization header at all", async () => {
    mockFullChain();

    const res = await POST(req({ bearer: null }), ctx());

    expect(res.status).toBe(401);
    expect(getRun).not.toHaveBeenCalled();
  });

  it("401s when there is no machine row for the run's (workspace, env)", async () => {
    vi.mocked(getRun).mockResolvedValue(RUN as never);
    vi.mocked(getDeploymentById).mockResolvedValue(DEPLOYMENT as never);
    vi.mocked(getAgentById).mockResolvedValue(AGENT as never);
    vi.mocked(getWorkspaceById).mockResolvedValue(WORKSPACE as never);
    vi.mocked(getMachineByWorkspaceEnv).mockResolvedValue(null);

    const res = await POST(req(), ctx());

    expect(res.status).toBe(401);
    expect(machineTokenMatches).not.toHaveBeenCalled();
  });

  it("401s when the machine row has no runNonce yet", async () => {
    vi.mocked(getRun).mockResolvedValue(RUN as never);
    vi.mocked(getDeploymentById).mockResolvedValue(DEPLOYMENT as never);
    vi.mocked(getAgentById).mockResolvedValue(AGENT as never);
    vi.mocked(getWorkspaceById).mockResolvedValue(WORKSPACE as never);
    vi.mocked(getMachineByWorkspaceEnv).mockResolvedValue({ ...MACHINE, runNonce: null } as never);

    const res = await POST(req(), ctx());

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("unauthorized");
  });

  it("calls completeRun with the parsed body and returns 200 for a valid token", async () => {
    mockFullChain();
    vi.mocked(machineTokenMatches).mockReturnValue(true);
    vi.mocked(completeRun).mockResolvedValue(undefined);
    vi.mocked(getRun).mockResolvedValueOnce(RUN as never).mockResolvedValueOnce({
      ...RUN,
      status: "succeeded",
    } as never);

    const res = await POST(req({ body: VALID_BODY }), ctx());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ runId: "r_1", status: "succeeded" });
    expect(completeRun).toHaveBeenCalledWith("r_1", VALID_BODY);
  });

  it("is a no-op (still 200) when completing an already-terminal run", async () => {
    // completeRun's own contract (unit-tested in lib/runs/store.ts) is that
    // its UPDATE only matches status IN (queued, running) — a retried
    // completion for a run that's already terminal changes nothing. At the
    // route level, that means: completeRun is still called (the route
    // doesn't pre-check status), but the re-read after it reflects the
    // run's real prior terminal status, not whatever the retried POST body
    // claimed, and the route still answers 200.
    mockFullChain();
    vi.mocked(machineTokenMatches).mockReturnValue(true);
    vi.mocked(completeRun).mockResolvedValue(undefined);
    const alreadyTerminal = { ...RUN, status: "succeeded" };
    vi.mocked(getRun).mockResolvedValueOnce(alreadyTerminal as never).mockResolvedValueOnce(alreadyTerminal as never);

    const res = await POST(req({ body: { ...VALID_BODY, status: "failed" } }), ctx());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.status).toBe("succeeded"); // unchanged by the retried "failed" POST
    expect(completeRun).toHaveBeenCalled();
  });

  it("touches the machine's lastSeenAt once auth succeeds (Finding 1b)", async () => {
    mockFullChain();
    vi.mocked(machineTokenMatches).mockReturnValue(true);
    vi.mocked(completeRun).mockResolvedValue(undefined);

    await POST(req(), ctx());

    expect(touchMachineLastSeen).toHaveBeenCalledWith("wm_1");
    expect(touchMachineLastSeen).toHaveBeenCalledTimes(1);
  });
});
