import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * Focused unit coverage for Finding 3 (machine 4xx must pass through, not
 * get flattened into a retryable 502) and Finding 8 (a presign failure must
 * short-circuit BEFORE the machine is ever woken). The full route contract
 * — auth, gates, idempotent replay, etc — lives in
 * tests/contract/invoke-route.test.ts; this file only exercises the two
 * infra-error branches these findings touch.
 */

vi.mock("@/lib/tokens/invoke", () => ({ verifyInvokeBearer: vi.fn() }));
vi.mock("@/lib/agents/registry", () => ({
  getAgentByName: vi.fn(),
  getLiveDeployment: vi.fn(),
  getVersionBundle: vi.fn(),
  getWorkspaceById: vi.fn(),
}));
vi.mock("@/lib/billing/quota", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/billing/quota")>();
  return { ...actual, assertWithinQuota: vi.fn() };
});
vi.mock("@/lib/compute/machines", () => ({ ensureWorkspaceMachine: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ mintSession: vi.fn() }));
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
import { createRun, markRunFailed, presignTracePut } from "@/lib/runs/store";
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

function req(body: unknown = {}): NextRequest {
  return new NextRequest("http://localhost/api/v1/agents/invoice-triage/invoke", {
    method: "POST",
    headers: { authorization: "Bearer itok_abc", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function ctx(name = "invoice-triage") {
  return { params: Promise.resolve({ name }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(verifyInvokeBearer).mockResolvedValue(TOKEN_INFO);
  vi.mocked(getAgentByName).mockResolvedValue(AGENT as never);
  vi.mocked(getLiveDeployment).mockResolvedValue(DEPLOYMENT as never);
  vi.mocked(assertWithinQuota).mockResolvedValue(undefined);
  vi.mocked(getWorkspaceById).mockResolvedValue(WORKSPACE as never);
  vi.mocked(createRun).mockResolvedValue({ id: "r_1", existing: false });
  vi.mocked(getVersionBundle).mockResolvedValue({ files: {} });
  vi.mocked(mintSession).mockResolvedValue("session-tok" as never);
  vi.mocked(presignTracePut).mockResolvedValue("https://s3.example/put");
  vi.mocked(ensureWorkspaceMachine).mockResolvedValue(MACHINE_TARGET as never);
  vi.stubGlobal("fetch", vi.fn());
});

describe("invoke route — Finding 3: machine 4xx passthrough", () => {
  it("passes through a machine 400 bad_bundle as non-retryable, without touching the idempotency key", async () => {
    vi.mocked(global.fetch).mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "bad_bundle", message: "bundle failed to parse" } }), {
        status: 400,
      }) as never
    );

    const res = await POST(req(), ctx());

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("bad_bundle");
    expect(body.error.message).toBe("bundle failed to parse");
    expect(body.error.retryable).toBe(false);

    // Genuine caller/bundle error, not an infra failure — markRunFailed is
    // called WITHOUT clearIdempotencyKey, so a retry with the same
    // Idempotency-Key replays this same failure rather than getting a fresh
    // attempt (see lib/runs/store.ts markRunFailed's docstring).
    expect(markRunFailed).toHaveBeenCalledWith("r_1", "bad_bundle");
  });

  it("falls back to the generic retryable 502 machine_error for a 5xx", async () => {
    vi.mocked(global.fetch).mockResolvedValue(new Response("boom", { status: 500 }) as never);

    const res = await POST(req(), ctx());

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error.code).toBe("machine_error");
    expect(body.error.retryable).toBe(true);
    expect(markRunFailed).toHaveBeenCalledWith("r_1", "machine_error", { clearIdempotencyKey: true });
  });

  it("falls back to the generic 502 for an unparseable 4xx body", async () => {
    vi.mocked(global.fetch).mockResolvedValue(new Response("not json", { status: 422 }) as never);

    const res = await POST(req(), ctx());

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error.code).toBe("machine_error");
  });
});

describe("invoke route — Finding 8: presign before wake", () => {
  it("500s storage_unconfigured and never wakes the machine when presigning fails", async () => {
    vi.mocked(presignTracePut).mockRejectedValue(new Error("SANAD_RUNS_BUCKET is not configured"));

    const res = await POST(req(), ctx());

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe("storage_unconfigured");
    expect(ensureWorkspaceMachine).not.toHaveBeenCalled();
    expect(markRunFailed).toHaveBeenCalledWith("r_1", "storage_unconfigured");
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
