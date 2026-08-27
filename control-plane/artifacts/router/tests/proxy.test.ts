/** End-to-end through a real socket: HTTP, header injection, and WS upgrade.
 *
 * NOTE: requests use raw node:http, NOT fetch — undici silently drops a
 * user-supplied Host header, which is the whole thing being tested here.
 */
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { loadConfig } from "../src/config.js";
import { RouteTable } from "../src/routes.js";
import { createServer } from "../src/index.js";

const HASH = "abc123def456";

let target: http.Server;
let router: http.Server;
let wss: WebSocketServer;
let routerPort: number;
let targetPort: number;
/* A SECOND target standing in for a user's dev server. Previously one echo
   server played both roles with AGENTD_PORT === PREVIEW_PORTS, which cannot
   express the rule that the agentd port is never previewable — and hid the
   fact that compute and preview resolve to different targets. */
let previewTarget: http.Server;
let previewWss: WebSocketServer;
let previewPort: number;

interface Res {
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}

const get = (path: string, host: string): Promise<Res> =>
  new Promise((resolve, reject) => {
    http
      .get(
        { host: "127.0.0.1", port: routerPort, path, headers: { host } },
        (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () =>
            resolve({ status: res.statusCode ?? 0, body, headers: res.headers })
          );
        }
      )
      .on("error", reject);
  });

beforeAll(async () => {
  // Target = a fake agentd/dev-server: echoes path over HTTP, echoes frames over WS.
  target = http.createServer((req, res) => {
    res.writeHead(200, {
      "content-type": "text/html",
      "x-frame-options": "DENY", // must be stripped on previews
    });
    res.end(`echo:${req.url}`);
  });
  wss = new WebSocketServer({ server: target, path: "/ws" });
  wss.on("connection", (ws) => ws.on("message", (m) => ws.send(`pong:${m}`)));
  await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
  targetPort = (target.address() as AddressInfo).port;

  // The user's dev server: separate process, separate port, its own WS for HMR.
  previewTarget = http.createServer((req, res) => {
    res.writeHead(200, {
      "content-type": "text/html",
      "x-frame-options": "DENY", // must be stripped on previews
    });
    res.end(`app:${req.url}`);
  });
  previewWss = new WebSocketServer({ server: previewTarget, path: "/hmr" });
  previewWss.on("connection", (ws) => ws.on("message", (m) => ws.send(`hmr:${m}`)));
  await new Promise<void>((r) => previewTarget.listen(0, "127.0.0.1", r));
  previewPort = (previewTarget.address() as AddressInfo).port;

  const config = loadConfig({
    ROUTER_SHARED_SECRET: "rsec",
    CONTROL_PLANE_URL: "https://cp.test",
    AGENTD_PORT: String(targetPort),
    // A RANGE, as production now uses — not an enumerated allowlist.
    PREVIEW_PORTS: "1024-65535",
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
  // Proxied WS/RST leftovers hold sockets open — upgraded sockets are not
  // covered by closeAllConnections, so terminate the WS clients directly.
  for (const client of wss.clients) client.terminate();
  wss.close();
  for (const client of previewWss.clients) client.terminate();
  previewWss.close();
  router.closeAllConnections();
  target.closeAllConnections();
  previewTarget.closeAllConnections();
  await new Promise((r) => router.close(r));
  await new Promise((r) => target.close(r));
  await new Promise((r) => previewTarget.close(r));
});

describe("router proxying", () => {
  it("proxies compute paths and strips the /u/<hash> prefix", async () => {
    const res = await get(`/u/${HASH}/internal/workspace/tree`, "compute.sanadcode.com");
    expect(res.status).toBe(200);
    expect(res.body).toBe("echo:/internal/workspace/tree");
    // Not a preview → no frame-ancestors injection
    expect(res.headers["content-security-policy"]).toBeUndefined();
  });

  it("proxies preview hosts and injects frame-ancestors", async () => {
    const res = await get("/index.html", `${HASH}-${previewPort}.preview.sanadcode.com`);
    expect(res.status).toBe(200);
    expect(res.body).toBe("app:/index.html");
    expect(res.headers["content-security-policy"]).toBe(
      "frame-ancestors https://www.sanadcode.com"
    );
    expect(res.headers["x-frame-options"]).toBeUndefined();
  });

  it("previews an ARBITRARY port, not just the four well-known ones", async () => {
    // `previewPort` is an ephemeral OS-assigned port — the whole point of the
    // range: a workspace runs whatever dev server the project uses.
    expect(previewPort).not.toBe(3000);
    const res = await get("/", `${HASH}-${previewPort}.preview.sanadcode.com`);
    expect(res.status).toBe(200);
  });

  it("REFUSES to preview the agentd port", async () => {
    // agentd is the workspace's own control API. It is bearer-protected and
    // would fail closed anyway, but it must not be addressable on a preview
    // hostname: previews carry no auth of their own.
    const res = await get("/internal/workspace/tree", `${HASH}-${targetPort}.preview.sanadcode.com`);
    expect(res.status).toBe(404);
  });

  it("proxies WebSocket upgrades over a PREVIEW host (HMR)", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${routerPort}/hmr`, {
      headers: { host: `${HASH}-${previewPort}.preview.sanadcode.com` },
    });
    const reply = await new Promise<string>((resolve, reject) => {
      ws.on("open", () => ws.send("reload"));
      ws.on("message", (m) => resolve(String(m)));
      ws.on("error", reject);
    });
    expect(reply).toBe("hmr:reload");
    ws.close();
  });

  it("404s unknown hosts and non-matching paths", async () => {
    expect((await get(`/u/${HASH}/ws`, "evil.example.com")).status).toBe(404);
    expect((await get("/nope", "compute.sanadcode.com")).status).toBe(404);
  });

  it("serves its own healthz", async () => {
    const res = await get("/healthz", "compute.sanadcode.com");
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: "ok" });
  });

  it("answers healthz for ANY Host header (ALB checks send the raw IP)", async () => {
    // Regression: requiring the public hostname made every ALB health check
    // 404 → targets never healthy → ECS kill-looped the fleet.
    for (const host of ["10.0.1.23:8080", "evil.example.com", ""]) {
      const res = await get("/healthz", host);
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ status: "ok" });
    }
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

describe("router crash resilience", () => {
  it("survives a client RST mid-upgrade (during the route lookup)", async () => {
    // Reproduces the outage: the raw socket dies while resolve() awaits the
    // control plane. Pre-fix, the socket's 'error' event had no listener and
    // killed the process (vitest would die with it).
    const sock = net.connect(routerPort, "127.0.0.1");
    await new Promise<void>((r) => sock.on("connect", r));
    sock.write(
      `GET /u/${HASH}/ws HTTP/1.1\r\n` +
        "Host: compute.sanadcode.com\r\n" +
        "Connection: Upgrade\r\nUpgrade: websocket\r\n" +
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
        "Sec-WebSocket-Version: 13\r\n\r\n"
    );
    sock.resetAndDestroy(); // RST, not FIN — the aggressive teardown browsers do
    await new Promise((r) => setTimeout(r, 100));

    const res = await get("/healthz", "compute.sanadcode.com");
    expect(res.status).toBe(200); // still alive
  });

  it("survives a WS upgrade to a dead workspace and keeps serving", async () => {
    // Point resolution at a port nobody listens on (a stopped task's IP).
    const deadConfig = loadConfig({
      ROUTER_SHARED_SECRET: "rsec",
      CONTROL_PLANE_URL: "https://cp.test",
      AGENTD_PORT: "1", // connection refused
      PREVIEW_PORTS: "1",
    } as NodeJS.ProcessEnv);
    const deadTable = new RouteTable(deadConfig, (async () =>
      new Response(JSON.stringify({ data: { taskIp: "127.0.0.1" } }), {
        status: 200,
      })) as unknown as typeof fetch);
    const deadRouter = createServer(deadConfig, deadTable);
    await new Promise<void>((r) => deadRouter.listen(0, "127.0.0.1", r));
    const deadPort = (deadRouter.address() as AddressInfo).port;

    const ws = new WebSocket(`ws://127.0.0.1:${deadPort}/u/${HASH}/ws`, {
      headers: { host: "compute.sanadcode.com" },
    });
    await new Promise<void>((resolve) => {
      ws.on("error", () => resolve()); // upgrade fails — that's expected
      ws.on("close", () => resolve());
    });

    const alive = await new Promise<number>((resolve, reject) => {
      http
        .get(
          {
            host: "127.0.0.1",
            port: deadPort,
            path: "/healthz",
            headers: { host: "compute.sanadcode.com" },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          }
        )
        .on("error", reject);
    });
    expect(alive).toBe(200);
    await new Promise((r) => deadRouter.close(r));
  });
});
