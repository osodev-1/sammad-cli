/** End-to-end through a real socket: HTTP, header injection, and WS upgrade.
 *
 * NOTE: requests use raw node:http, NOT fetch — undici silently drops a
 * user-supplied Host header, which is the whole thing being tested here.
 */
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
let targetPort: number;

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
  const wss = new WebSocketServer({ server: target, path: "/ws" });
  wss.on("connection", (ws) => ws.on("message", (m) => ws.send(`pong:${m}`)));
  await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
  targetPort = (target.address() as AddressInfo).port;

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
    const res = await get(`/u/${HASH}/internal/workspace/tree`, "compute.sanadcode.com");
    expect(res.status).toBe(200);
    expect(res.body).toBe("echo:/internal/workspace/tree");
    // Not a preview → no frame-ancestors injection
    expect(res.headers["content-security-policy"]).toBeUndefined();
  });

  it("proxies preview hosts and injects frame-ancestors", async () => {
    const res = await get("/index.html", `${HASH}-${targetPort}.preview.sanadcode.com`);
    expect(res.status).toBe(200);
    expect(res.body).toBe("echo:/index.html");
    expect(res.headers["content-security-policy"]).toBe(
      "frame-ancestors https://www.sanadcode.com"
    );
    expect(res.headers["x-frame-options"]).toBeUndefined();
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
