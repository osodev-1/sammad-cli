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

/**
 * Per-alias upstream override — the escape hatch from RunPod's sync-proxy
 * limits (its /openai route hard-caps every streamed response at ~300s, which
 * kills long-thinking turns; hh validation 2026-08-14). Point an alias at ANY
 * OpenAI-compatible base URL with env vars — a provider swap is then an env
 * flip, no code deploy:
 *
 *   MODEL_KIMI_K3_BASE_URL = https://api.moonshot.ai/v1
 *   MODEL_KIMI_K3_API_KEY  = sk-…            (omitted → no Authorization header)
 *   MODEL_KIMI_K3_MODEL    = kimi-k3         (optional; defaults to the RunPod
 *                                             target's model name)
 *
 * Env key = MODEL_<alias uppercased, non-alphanumerics → "_">_….
 */
export interface UpstreamOverride {
  baseUrl: string;
  apiKey: string | null;
  model: string | null;
}

export function envOverride(alias: string): UpstreamOverride | null {
  const key = alias.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  const baseUrl = process.env[`MODEL_${key}_BASE_URL`];
  if (!baseUrl) return null;
  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    apiKey: process.env[`MODEL_${key}_API_KEY`] || null,
    model: process.env[`MODEL_${key}_MODEL`] || null,
  };
}
