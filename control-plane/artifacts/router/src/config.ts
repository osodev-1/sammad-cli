/** Router configuration — all env-driven, fail-fast on the credential. */

export interface RouterConfig {
  port: number;
  controlPlaneUrl: string;
  routerSecret: string;
  computeHost: string;
  previewSuffix: string;
  allowedPreviewPorts: Set<number>;
  agentdPort: number;
  routeCacheMs: number;
  negativeCacheMs: number;
  frameAncestors: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RouterConfig {
  const routerSecret = env.ROUTER_SHARED_SECRET ?? "";
  if (!routerSecret) throw new Error("ROUTER_SHARED_SECRET is required");
  return {
    port: Number(env.PORT ?? 8080),
    controlPlaneUrl: (env.CONTROL_PLANE_URL ?? "https://www.sanadcode.com").replace(/\/+$/, ""),
    routerSecret,
    computeHost: env.COMPUTE_HOST ?? "compute.sanadcode.com",
    previewSuffix: env.PREVIEW_SUFFIX ?? ".preview.sanadcode.com",
    allowedPreviewPorts: new Set(
      (env.PREVIEW_PORTS ?? "3000,5173,8000,8080").split(",").map((p) => Number(p.trim()))
    ),
    agentdPort: Number(env.AGENTD_PORT ?? 7070),
    routeCacheMs: Number(env.ROUTE_CACHE_MS ?? 30_000),
    negativeCacheMs: Number(env.NEGATIVE_CACHE_MS ?? 5_000),
    frameAncestors: env.FRAME_ANCESTORS ?? "https://www.sanadcode.com",
  };
}
