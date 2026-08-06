/**
 * Host/path → workspace-task routing.
 *
 *   compute.sanadcode.com/u/<hash12>/<rest>      → task:7070/<rest>   (agentd: /ws, /internal/*)
 *   <hash12>-<port>.preview.sanadcode.com/<any>  → task:<port>/<any>  (user dev servers)
 *
 * Task IPs come from the control plane's route endpoint (backed by
 * workspace_tasks), cached briefly; entries are purged on connect failure so a
 * restarted task (new IP) recovers within one retry.
 */
import type { RouterConfig } from "./config.js";

const HASH_RE = /^[a-f0-9]{12}$/;

export type Parsed =
  | { kind: "compute"; hash: string; rest: string }
  | { kind: "preview"; hash: string; port: number }
  | { kind: "router-health" }
  | null;

export function parseRequest(config: RouterConfig, host: string | undefined, url: string): Parsed {
  const bareHost = (host ?? "").split(":")[0].toLowerCase();
  if (!bareHost) return null;

  if (bareHost === config.computeHost) {
    if (url === "/healthz") return { kind: "router-health" };
    const m = url.match(/^\/u\/([a-f0-9]{12})(\/.*)?$/);
    if (!m) return null;
    return { kind: "compute", hash: m[1], rest: m[2] || "/" };
  }

  if (bareHost.endsWith(config.previewSuffix)) {
    const label = bareHost.slice(0, -config.previewSuffix.length);
    const m = label.match(/^([a-f0-9]{12})-(\d{2,5})$/);
    if (!m) return null;
    const port = Number(m[2]);
    if (!HASH_RE.test(m[1]) || !config.allowedPreviewPorts.has(port)) return null;
    return { kind: "preview", hash: m[1], port };
  }

  return null;
}

interface CacheEntry {
  ip: string | null; // null = negative (unknown workspace)
  expiresAt: number;
}

export class RouteTable {
  private cache = new Map<string, CacheEntry>();

  constructor(
    private readonly config: RouterConfig,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async resolve(hash: string): Promise<string | null> {
    const now = Date.now();
    const hit = this.cache.get(hash);
    if (hit && hit.expiresAt > now) return hit.ip;

    let ip: string | null = null;
    try {
      const res = await this.fetchImpl(
        `${this.config.controlPlaneUrl}/api/v1/compute/route?hash=${encodeURIComponent(hash)}`,
        { headers: { "x-router-secret": this.config.routerSecret } }
      );
      if (res.ok) {
        const body = (await res.json()) as { data?: { taskIp?: string } };
        ip = body.data?.taskIp ?? null;
      }
    } catch {
      // Control plane unreachable — treat as unknown; negative-cached briefly.
      ip = null;
    }
    this.cache.set(hash, {
      ip,
      expiresAt: now + (ip ? this.config.routeCacheMs : this.config.negativeCacheMs),
    });
    return ip;
  }

  /** Forget a workspace (called on proxy connect errors — task likely moved). */
  purge(hash: string): void {
    this.cache.delete(hash);
  }
}
