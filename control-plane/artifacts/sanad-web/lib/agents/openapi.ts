/**
 * Per-agent OpenAPI document (RT-3): a pure, DB-free projection of a
 * worker.yaml `interface` stanza into an OpenAPI 3.1 description of the
 * agent's one invoke endpoint. Kept separate from the route (Task 14) so the
 * type-mapping and shape rules are unit-testable without touching the DB or
 * Next's request/response plumbing.
 */

/** P0 type map: everything that isn't "number" or "boolean" is a string. */
function jsonSchemaType(t: string): { type: "number" | "boolean" | "string" } {
  if (t === "number") return { type: "number" };
  if (t === "boolean") return { type: "boolean" };
  return { type: "string" };
}

/**
 * A worker.yaml inputs/outputs map -> a JSON Schema object's properties +
 * required. Keys are sorted so the document (and its `required` array) is
 * stable regardless of the source map's insertion order — the same
 * canonicalization concern as registry.ts's bundleContentHash.
 */
function schemaFrom(fields: Record<string, string>): {
  properties: Record<string, { type: "number" | "boolean" | "string" }>;
  required: string[];
} {
  const keys = Object.keys(fields).sort();
  const properties: Record<string, { type: "number" | "boolean" | "string" }> = {};
  for (const key of keys) properties[key] = jsonSchemaType(fields[key]);
  return { properties, required: keys };
}

export function buildAgentOpenApi(p: {
  agentName: string;
  interfaceSpec: { inputs: Record<string, string>; outputs: Record<string, string> };
}): object {
  const invokePath = `/api/v1/agents/${p.agentName}/invoke`;
  const request = schemaFrom(p.interfaceSpec.inputs);
  const response = schemaFrom(p.interfaceSpec.outputs);

  return {
    openapi: "3.1.0",
    info: {
      title: `${p.agentName} — sanad agent`,
      version: "1.0.0",
    },
    paths: {
      [invokePath]: {
        post: {
          operationId: "invokeAgent",
          summary: `Invoke ${p.agentName}`,
          security: [{ invokeToken: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: request.properties,
                  required: request.required,
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Run result",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: response.properties,
                    required: response.required,
                  },
                },
              },
            },
          },
        },
      },
    },
    components: {
      securitySchemes: {
        invokeToken: { type: "http", scheme: "bearer" },
      },
    },
    security: [{ invokeToken: [] }],
  };
}
