import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth/session", () => ({
  verifyBearer: vi.fn(),
}));
vi.mock("@/lib/agents/registry", () => ({
  getAgentByName: vi.fn(),
  getActiveDeployment: vi.fn(),
  getVersionBundle: vi.fn(),
}));

import { verifyBearer } from "@/lib/auth/session";
import { getActiveDeployment, getAgentByName, getVersionBundle } from "@/lib/agents/registry";
import { GET } from "@/app/api/v1/agents/[name]/openapi.json/route";

const SESSION = { sessionId: "sess_1", userId: "user_1", orgId: "org_1" };

const AGENT = {
  id: "ag_1",
  workspaceId: "ws_1",
  name: "invoice-triage",
  ownerUserId: "user_1",
  status: "active",
  description: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
};

const PROD_WORKER_YAML = "interface:\n  inputs: {q: string}\n  outputs: {answer: string}\n";
const DEV_WORKER_YAML = "interface:\n  inputs: {n: number}\n  outputs: {ok: boolean}\n";

function deployment(env: "dev" | "prod", overrides: Record<string, unknown> = {}) {
  return {
    id: `dp_${env}`,
    agentId: AGENT.id,
    agentVersionId: `av_${env}`,
    env,
    status: "active",
    maxTurnSeconds: 900,
    maxStepsPerTurn: 100,
    maxTokensPerRun: 2_000_000,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function req(bearer?: string): NextRequest {
  return new NextRequest(
    "http://localhost/api/v1/agents/invoice-triage/openapi.json",
    { headers: bearer !== undefined ? { authorization: `Bearer ${bearer}` } : {} }
  );
}

function ctx(name = "invoice-triage") {
  return { params: Promise.resolve({ name }) };
}

function invokeSchema(doc: any) {
  return doc.paths["/api/v1/agents/invoice-triage/invoke"].post.requestBody
    .content["application/json"].schema;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/v1/agents/[name]/openapi.json", () => {
  it("401s with no/invalid bearer", async () => {
    vi.mocked(verifyBearer).mockResolvedValue(null);

    const res = await GET(req(), ctx());

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("unauthorized");
    expect(getAgentByName).not.toHaveBeenCalled();
  });

  it("404s not_found for an unknown or foreign-org agent name", async () => {
    vi.mocked(verifyBearer).mockResolvedValue(SESSION);
    // getAgentByName's inferred return type collapses to non-nullable
    // (no `noUncheckedIndexedAccess` in this project's tsconfig — `rows[0]
    // ?? null` types as just `rows[0]`'s element type), same reason
    // logout.test.ts casts its null fixtures `as never`.
    vi.mocked(getAgentByName).mockResolvedValue(null as never);

    const res = await GET(req("tok"), ctx());

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("not_found");
  });

  it("prefers prod's active deployment when both prod and dev are active", async () => {
    vi.mocked(verifyBearer).mockResolvedValue(SESSION);
    vi.mocked(getAgentByName).mockResolvedValue(AGENT);
    vi.mocked(getActiveDeployment).mockImplementation(async (_agentId, env) =>
      env === "prod" ? deployment("prod") : deployment("dev")
    );
    vi.mocked(getVersionBundle).mockImplementation(async (versionId) =>
      versionId === "av_prod"
        ? { files: { "worker.yaml": PROD_WORKER_YAML } }
        : { files: { "worker.yaml": DEV_WORKER_YAML } }
    );

    const res = await GET(req("tok"), ctx());

    expect(res.status).toBe(200);
    const doc = await res.json();
    const schema = invokeSchema(doc);
    // prod's interface (q: string) was used, not dev's (n: number)
    expect(schema.properties.q).toEqual({ type: "string" });
    expect(schema.properties.n).toBeUndefined();
  });

  it("falls back to dev's active deployment when prod has none (paused/never deployed)", async () => {
    vi.mocked(verifyBearer).mockResolvedValue(SESSION);
    vi.mocked(getAgentByName).mockResolvedValue(AGENT);
    // getActiveDeployment only ever returns "active" rows — a paused prod
    // deployment surfaces here exactly like no prod deployment at all: null.
    vi.mocked(getActiveDeployment).mockImplementation(async (_agentId, env) =>
      env === "prod" ? (null as never) : deployment("dev")
    );
    vi.mocked(getVersionBundle).mockResolvedValue({ files: { "worker.yaml": DEV_WORKER_YAML } });

    const res = await GET(req("tok"), ctx());

    expect(res.status).toBe(200);
    const doc = await res.json();
    const schema = invokeSchema(doc);
    expect(schema.properties.n).toEqual({ type: "number" });
  });

  it("404s not_deployed when neither env has an active deployment", async () => {
    vi.mocked(verifyBearer).mockResolvedValue(SESSION);
    vi.mocked(getAgentByName).mockResolvedValue(AGENT);
    vi.mocked(getActiveDeployment).mockResolvedValue(null as never);

    const res = await GET(req("tok"), ctx());

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("not_deployed");
    expect(getVersionBundle).not.toHaveBeenCalled();
  });

  it("500s internal_error when the deployed worker.yaml is unparseable", async () => {
    vi.mocked(verifyBearer).mockResolvedValue(SESSION);
    vi.mocked(getAgentByName).mockResolvedValue(AGENT);
    vi.mocked(getActiveDeployment).mockImplementation(async (_agentId, env) =>
      env === "prod" ? deployment("prod") : (null as never)
    );
    vi.mocked(getVersionBundle).mockResolvedValue({
      files: { "worker.yaml": "interface:\n  inputs: [1, 2\n" },
    });

    const res = await GET(req("tok"), ctx());

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe("internal_error");
  });

  it("returns the raw OpenAPI document on success — no {data,meta} envelope", async () => {
    vi.mocked(verifyBearer).mockResolvedValue(SESSION);
    vi.mocked(getAgentByName).mockResolvedValue(AGENT);
    vi.mocked(getActiveDeployment).mockImplementation(async (_agentId, env) =>
      env === "prod" ? deployment("prod") : (null as never)
    );
    vi.mocked(getVersionBundle).mockResolvedValue({ files: { "worker.yaml": PROD_WORKER_YAML } });

    const res = await GET(req("tok"), ctx());

    expect(res.status).toBe(200);
    const doc = await res.json();
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.data).toBeUndefined();
    expect(doc.error).toBeUndefined();
    expect(doc.components.securitySchemes.invokeToken).toEqual({
      type: "http",
      scheme: "bearer",
    });
    const schema = invokeSchema(doc);
    expect(schema.properties.q).toEqual({ type: "string" });
    expect(schema.required).toEqual(["q"]);
  });
});
