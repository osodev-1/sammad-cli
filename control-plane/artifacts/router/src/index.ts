/**
 * sanad-router: the single ingress behind the ALB for per-user workspace
 * tasks. Dumb by design — hostname/path → task IP, WebSocket upgrades passed
 * through, one security header injected on previews. All state lives in the
 * control plane; the router only caches lookups for a few seconds.
 */
import http from "node:http";
import httpProxy from "http-proxy";
import { loadConfig } from "./config.js";
import { parseRequest, RouteTable } from "./routes.js";

export function createServer(
  config = loadConfig(),
  routeTable = new RouteTable(config)
): http.Server {
  const proxy = httpProxy.createProxyServer({ xfwd: true });

  // Inject anti-clickjacking on preview responses: the workspace UI may frame
  // previews; nothing else may. (Dev servers never set these themselves.)
  proxy.on("proxyRes", (proxyRes, req) => {
    if ((req as PreviewTagged).__sanadPreview) {
      proxyRes.headers["content-security-policy"] = `frame-ancestors ${config.frameAncestors}`;
      delete proxyRes.headers["x-frame-options"];
    }
  });

  interface PreviewTagged extends http.IncomingMessage {
    __sanadPreview?: boolean;
    __sanadHash?: string;
  }

  // Last-resort proxy error hook: per-call callbacks below handle the normal
  // failure paths, but http-proxy can surface late socket errors here — they
  // must never become an unhandled 'error' event (that kills the process).
  proxy.on("error", (err, _req, resOrSocket) => {
    console.log(JSON.stringify({ msg: "proxy error", error: String(err) }));
    if (resOrSocket instanceof http.ServerResponse) {
      if (!resOrSocket.headersSent) {
        resOrSocket.writeHead(502, { "content-type": "text/plain" });
      }
      resOrSocket.end("upstream error");
    } else {
      resOrSocket?.destroy();
    }
  });

  const fail = (res: http.ServerResponse, status: number, message: string) => {
    res.writeHead(status, { "content-type": "text/plain" });
    res.end(message);
  };

  const server = http.createServer(async (req: PreviewTagged, res) => {
    try {
      const parsed = parseRequest(config, req.headers.host, req.url ?? "/");
      if (!parsed) {
        fail(res, 404, "not found");
        return;
      }
      if (parsed.kind === "router-health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }

      const ip = await routeTable.resolve(parsed.hash);
      if (!ip) {
        fail(res, 503, "workspace is not running");
        return;
      }

      if (parsed.kind === "compute") {
        req.url = parsed.rest;
        proxy.web(req, res, { target: `http://${ip}:${config.agentdPort}` }, () => {
          routeTable.purge(parsed.hash);
          fail(res, 502, "workspace unreachable");
        });
        return;
      }
      req.__sanadPreview = true;
      proxy.web(req, res, { target: `http://${ip}:${parsed.port}` }, () => {
        routeTable.purge(parsed.hash);
        fail(res, 502, "nothing is listening on this port");
      });
      return;
    } catch (err) {
      console.log(JSON.stringify({ msg: "request handler error", error: String(err) }));
      if (!res.headersSent) fail(res, 500, "router error");
      else res.end();
    }
  });

  server.on("upgrade", async (req: PreviewTagged, socket, head) => {
    // The client can reset this socket at any moment — including while we
    // await the route lookup below. Without a listener that reset is an
    // unhandled 'error' event and takes the whole router down.
    socket.on("error", () => socket.destroy());
    try {
      const parsed = parseRequest(config, req.headers.host, req.url ?? "/");
      if (!parsed || parsed.kind === "router-health") {
        socket.destroy();
        return;
      }

      const ip = await routeTable.resolve(parsed.hash);
      if (socket.destroyed) return;
      if (!ip) {
        socket.destroy();
        return;
      }

      const port = parsed.kind === "compute" ? config.agentdPort : parsed.port;
      if (parsed.kind === "compute") req.url = parsed.rest;
      proxy.ws(req, socket, head, { target: `http://${ip}:${port}` }, () => {
        routeTable.purge(parsed.hash);
        socket.destroy();
      });
    } catch (err) {
      console.log(JSON.stringify({ msg: "upgrade handler error", error: String(err) }));
      socket.destroy();
    }
  });

  // A connection-level error before the request parses (bad TLS bytes, RST
  // mid-headers) is emitted on the server; without a listener it crashes.
  server.on("clientError", (_err, socket) => {
    socket.destroy();
  });

  return server;
}

// Entrypoint (skipped under tests, which import createServer directly).
if (process.env.NODE_ENV !== "test") {
  // The router is stateless: any stray error is logged and survived — a
  // crashed router takes every workspace offline until ECS replaces it.
  process.on("uncaughtException", (err) => {
    console.log(JSON.stringify({ msg: "uncaught exception", error: String(err), stack: err?.stack }));
  });
  process.on("unhandledRejection", (reason) => {
    console.log(JSON.stringify({ msg: "unhandled rejection", error: String(reason) }));
  });
  const config = loadConfig();
  createServer(config).listen(config.port, "0.0.0.0", () => {
    console.log(JSON.stringify({ msg: "sanad-router listening", port: config.port }));
  });
}
