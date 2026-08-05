// The models the CLI is offered (mint response modelSettings + default). The
// gateway maps each alias to a RunPod endpoint (see api-server/src/lib/models.ts).
// Starting with Kimi K3 (a ready-to-use RunPod Public Endpoint); add more here
// and in the gateway map together.
export const MODEL_CATALOG = [
  { name: "kimi-k3", maxContextSize: 256000, capabilities: [] },
] as const;

export const DEFAULT_MODEL_ALIAS = "kimi-k3";
