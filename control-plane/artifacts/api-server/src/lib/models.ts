/**
 * CLI alias → the RunPod endpoint that serves it. `slug` is a RunPod Public
 * Endpoint slug (e.g. "moonshot-kimi") or your own serverless endpoint id — both
 * are reached at api.runpod.ai/v2/{slug}/openai/v1. `model` is the model name
 * RunPod expects in the request body. Keep in lockstep with sanad-web's
 * MODEL_CATALOG (lib/models/catalog.ts).
 */
export interface RunpodTarget {
  slug: string;
  model: string;
}

export const ALIAS_TO_RUNPOD: Record<string, RunpodTarget> = {
  // Kimi K3 — a ready-to-use RunPod Public Endpoint (no deployment needed).
  "kimi-k3": { slug: "moonshot-kimi", model: "kimi-k3" },
};

/** Resolve a CLI alias to its RunPod target, or null if unknown. */
export function resolveTarget(alias: string): RunpodTarget | null {
  return ALIAS_TO_RUNPOD[alias] ?? null;
}
