/** End-to-end through a real socket: HTTP, header injection, and WS upgrade. */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { loadConfig } from "../src/config.js";
import { RouteTable } from "../src/routes.js";
import { createServer } from "../src/index.js";

const HASH = "abc123def456";

let target: http.Server;
let router: http.Server;
let routerPort: number;

beforeAll(async () => {
  // Target = a fake agentd/dev-server: echoes path over HTTP, echoes frames over WS.
  target = http.createServer((req, res) => {
    res.writeHead(200, {
      "content-type": "text/html",
      "x-frame-options": "DENY", // must be stripped on previews
    });
    res.end(`echo:${req.url}`);
  });
  const wss = new WebSocketServer({ server: target, path: "/ws" });
  wss.on("connection", (ws) => ws.on("message", (m) => ws.send(`pong:${m}`)));
  await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
  const targetPort = (target.address() as AddressInfo).port;

  const config = loadConfig({
    ROUTER_SHARED_SECRET: "rsec",
    CONTROL_PLANE_URL: "https://cp.test",
    AGENTD_PORT: String(targetPort),
    PREVIEW_PORTS: String(targetPort),
  } as NodeJS.ProcessEnv);

  const table = new RouteTable(config, (async () =>
    new Response(JSON.stringify({ data: { taskIp: "127.0.0.1" } }), {
      status: 200,
    })) as unknown as typeof fetch);

  router = createServer(config, table);
  await new Promise<void>((r) => router.listen(0, "127.0.0.1", r));
  routerPort = (router.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise((r) => router.close(r));
  await new Promise((r) => target.close(r));
});

describe("router proxying", () => {
  it("proxies compute paths and strips the /u/<hash> prefix", async () => {
    const res = await fetch(`http://127.0.0.1:${routerPort}/u/${HASH}/internal/workspace/tree`, {
      headers: { host: "compute.sanadcode.com" },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("echo:/internal/workspace/tree");
    // Not a preview → no frame-ancestors injection
    expect(res.headers.get("content-security-policy")).toBeNull();
  });

  it("proxies preview hosts and injects frame-ancestors", async () => {
    const targetPort = (target.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${routerPort}/index.html`, {
      headers: { host: `${HASH}-${targetPort}.preview.sanadcode.com` },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("echo:/index.html");
    expect(res.headers.get("content-security-policy")).toBe(
      "frame-ancestors https://www.sanadcode.com"
    );
    expect(res.headers.get("x-frame-options")).toBeNull();
  });

  it("404s unknown hosts and non-matching paths", async () => {
    const bad = await fetch(`http://127.0.0.1:${routerPort}/u/${HASH}/ws`, {
      headers: { host: "evil.example.com" },
    });
    expect(bad.status).toBe(404);
    const noPath = await fetch(`http://127.0.0.1:${routerPort}/nope`, {
      headers: { host: "compute.sanadcode.com" },
    });
    expect(noPath.status).toBe(404);
  });

  it("serves its own healthz", async () => {
    const res = await fetch(`http://127.0.0.1:${routerPort}/healthz`, {
      headers: { host: "compute.sanadcode.com" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("proxies WebSocket upgrades end-to-end", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${routerPort}/u/${HASH}/ws`, {
      headers: { host: "compute.sanadcode.com" },
    });
    const reply = await new Promise<string>((resolve, reject) => {
      ws.on("open", () => ws.send("marco"));
      ws.on("message", (m) => resolve(String(m)));
      ws.on("error", reject);
    });
    expect(reply).toBe("pong:marco");
    ws.close();
  });
});
