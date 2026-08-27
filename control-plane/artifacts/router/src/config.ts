/** Router configuration — all env-driven, fail-fast on the credential. */

export interface RouterConfig {
  port: number;
  controlPlaneUrl: string;
  routerSecret: string;
  computeHost: string;
  previewSuffix: string;
  /** True if this port may be previewed. A PREDICATE, not a fixed set: a
   * workspace runs whatever dev server the user's project uses, so pinning
   * four well-known ports meant anything on 4321/7777/… was refused by the
   * router even though the process was listening. */
  isPreviewablePort: (port: number) => boolean;
  agentdPort: number;
  routeCacheMs: number;
  negativeCacheMs: number;
  frameAncestors: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RouterConfig {
  const routerSecret = env.ROUTER_SHARED_SECRET ?? "";
  if (!routerSecret) throw new Error("ROUTER_SHARED_SECRET is required");
  const agentdPort = Number(env.AGENTD_PORT ?? 7070);
  return {
    port: Number(env.PORT ?? 8080),
    controlPlaneUrl: (env.CONTROL_PLANE_URL ?? "https://www.sanadcode.com").replace(/\/+$/, ""),
    routerSecret,
    computeHost: env.COMPUTE_HOST ?? "compute.sanadcode.com",
    previewSuffix: env.PREVIEW_SUFFIX ?? ".preview.sanadcode.com",
    isPreviewablePort: parsePreviewPorts(env.PREVIEW_PORTS ?? "1024-65535", agentdPort),
    agentdPort,
    routeCacheMs: Number(env.ROUTE_CACHE_MS ?? 30_000),
    negativeCacheMs: Number(env.NEGATIVE_CACHE_MS ?? 5_000),
    frameAncestors: env.FRAME_ANCESTORS ?? "https://www.sanadcode.com",
  };
}

/**
 * Parse `PREVIEW_PORTS` into a predicate. Accepts comma-separated single
 * ports and `lo-hi` ranges, e.g. "3000,5173" or "1024-65535,80".
 *
 * `agentdPort` is ALWAYS refused regardless of the spec. agentd is the
 * workspace's own control API on the same host; it is bearer-protected and
 * would fail closed anyway, but it must not be addressable on a preview
 * hostname — previews carry no auth of their own, and the two should never
 * share a reachability story.
 */
export function parsePreviewPorts(
  spec: string,
  agentdPort: number
): (port: number) => boolean {
  const singles = new Set<number>();
  const ranges: Array<[number, number]> = [];
  for (const raw of spec.split(",")) {
    const part = raw.trim();
    if (!part) continue;
    const range = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const lo = Number(range[1]);
      const hi = Number(range[2]);
      if (Number.isInteger(lo) && Number.isInteger(hi) && lo <= hi) ranges.push([lo, hi]);
      continue;
    }
    const one = Number(part);
    if (Number.isInteger(one)) singles.add(one);
  }
  return (port: number): boolean => {
    if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
    if (port === agentdPort) return false;
    if (singles.has(port)) return true;
    return ranges.some(([lo, hi]) => port >= lo && port <= hi);
  };
}
