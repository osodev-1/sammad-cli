import { describe, it, expect } from "vitest";
import { buildAgentOpenApi } from "@/lib/agents/openapi";

describe("buildAgentOpenApi", () => {
  const doc: any = buildAgentOpenApi({
    agentName: "invoice-triage",
    interfaceSpec: { inputs: { q: "string", n: "number" }, outputs: { answer: "string" } },
  });
  it("declares the invoke path with typed request properties", () => {
    const body = doc.paths["/api/v1/agents/invoice-triage/invoke"].post
      .requestBody.content["application/json"].schema;
    expect(body.properties.q).toEqual({ type: "string" });
    expect(body.properties.n).toEqual({ type: "number" });
    expect(body.required).toEqual(["n", "q"]);
  });
  it("declares bearer auth", () => {
    expect(doc.components.securitySchemes.invokeToken).toEqual({
      type: "http", scheme: "bearer",
    });
  });
});
