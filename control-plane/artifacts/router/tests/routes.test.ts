import { describe, it, expect, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { parseRequest, RouteTable } from "../src/routes.js";

const config = loadConfig({
  ROUTER_SHARED_SECRET: "rsec",
  CONTROL_PLANE_URL: "https://cp.test",
} as NodeJS.ProcessEnv);

const HASH = "abc123def456";

describe("parseRequest", () => {
  it("routes compute hosts by /u/<hash> path", () => {
    expect(parseRequest(config, "compute.sanadcode.com", `/u/${HASH}/ws`)).toEqual({
      kind: "compute",
      hash: HASH,
      rest: "/ws",
    });
    expect(
      parseRequest(config, "compute.sanadcode.com:443", `/u/${HASH}/internal/workspace/tree?path=`)
    ).toEqual({ kind: "compute", hash: HASH, rest: "/internal/workspace/tree?path=" });
    expect(parseRequest(config, "compute.sanadcode.com", "/healthz")).toEqual({
      kind: "router-health",
    });
    expect(parseRequest(config, "compute.sanadcode.com", "/u/BADHASH/ws")).toBeNull();
    expect(parseRequest(config, "compute.sanadcode.com", "/other")).toBeNull();
  });

  it("routes preview hosts by <hash>-<port> label with an allowlisted port", () => {
    expect(parseRequest(config, `${HASH}-3000.preview.sanadcode.com`, "/index.html")).toEqual({
      kind: "preview",
      hash: HASH,
      port: 3000,
    });
    expect(parseRequest(config, `${HASH}-5173.preview.sanadcode.com`, "/")).toMatchObject({
      port: 5173,
    });
    // ANY port in range — a workspace runs whatever the project uses, so an
    // enumerated allowlist refused real dev servers (4321, 7777, …) that were
    // genuinely listening.
    expect(parseRequest(config, `${HASH}-9999.preview.sanadcode.com`, "/")).toMatchObject({
      port: 9999,
    });
    expect(parseRequest(config, `${HASH}-54321.preview.sanadcode.com`, "/")).toMatchObject({
      port: 54321,
    });
    // Below the range: privileged ports the container's unprivileged `dev`
    // user cannot bind anyway.
    expect(parseRequest(config, `${HASH}-22.preview.sanadcode.com`, "/")).toBeNull();
    // NEVER agentd, whatever the spec says — previews carry no auth.
    expect(parseRequest(config, `${HASH}-7070.preview.sanadcode.com`, "/")).toBeNull();
    // Malformed labels
    expect(parseRequest(config, `nothash-3000.preview.sanadcode.com`, "/")).toBeNull();
    expect(parseRequest(config, "preview.sanadcode.com", "/")).toBeNull();
  });

  it("rejects unknown hosts", () => {
    expect(parseRequest(config, "evil.example.com", "/u/abc123def456/ws")).toBeNull();
    expect(parseRequest(config, undefined, "/")).toBeNull();
  });
});

describe("RouteTable", () => {
  it("caches positives, negative-caches misses, purges on demand", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { taskIp: "10.0.0.9" } }), { status: 200 })
      )
      .mockResolvedValueOnce(new Response("nf", { status: 404 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { taskIp: "10.0.0.10" } }), { status: 200 })
      );
    const table = new RouteTable(config, fetchMock as unknown as typeof fetch);

    expect(await table.resolve(HASH)).toBe("10.0.0.9");
    expect(await table.resolve(HASH)).toBe("10.0.0.9"); // cached
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(`https://cp.test/api/v1/compute/route?hash=${HASH}`);
    expect(init.headers["x-router-secret"]).toBe("rsec");

    expect(await table.resolve("aaaaaaaaaaaa")).toBeNull(); // negative
    expect(await table.resolve("aaaaaaaaaaaa")).toBeNull(); // negative cached
    expect(fetchMock).toHaveBeenCalledTimes(2);

    table.purge(HASH);
    expect(await table.resolve(HASH)).toBe("10.0.0.10"); // refetched after purge
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
