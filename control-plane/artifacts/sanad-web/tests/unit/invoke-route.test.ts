import { describe, it, expect } from "vitest";
import { invokeGate, newRunId } from "@/lib/runs/store";

describe("invoke gate", () => {
  const base = { tokenAgentId: "ag_1", pathAgentId: "ag_1", deployment: { status: "active" } };
  it("passes an active deployment", () => expect(invokeGate(base).ok).toBe(true));
  it("403s a cross-agent token", () =>
    expect(invokeGate({ ...base, tokenAgentId: "ag_2" })).toMatchObject({ status: 403, code: "token_scope" }));
  it("404s when not deployed", () =>
    expect(invokeGate({ ...base, deployment: null })).toMatchObject({ status: 404, code: "not_deployed" }));
  it("409s a paused deployment", () =>
    expect(invokeGate({ ...base, deployment: { status: "paused" } })).toMatchObject({ status: 409, code: "paused" }));
});

describe("run ids", () => {
  it("are r_<12 hex>", () => expect(newRunId()).toMatch(/^r_[0-9a-f]{12}$/));
});
