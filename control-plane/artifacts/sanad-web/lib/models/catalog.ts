// The models the CLI is offered (mint response modelSettings + default). The
// gateway maps each alias to a RunPod endpoint (see api-server/src/lib/models.ts).
// Starting with Kimi K3 (a ready-to-use RunPod Public Endpoint); add more here
// and in the gateway map together.
export const MODEL_CATALOG = [
  { name: "kimi-k3", maxContextSize: 256000, capabilities: [] },
] as const;

export const DEFAULT_MODEL_ALIAS = "kimi-k3";

// Placeholder pricing (USD per million tokens) — flagged for Omar's sign-off
// before GA. An alias missing from this map is NOT an error: costUsdMicros
// (lib/runs/store.ts) treats it as free (cost 0) rather than throwing, so an
// unpriced/experimental model never blocks a run from completing.
export const MODEL_PRICING: Record<string, { inUsdPerMTok: number; outUsdPerMTok: number }> = {
  "kimi-k3": { inUsdPerMTok: 0.6, outUsdPerMTok: 2.5 },
};
