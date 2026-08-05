/**
 * Alias → Azure AI Foundry deployment name. Must stay in lockstep with the
 * control plane's catalog (sanad-web/lib/models/catalog.ts): the CLI only ever
 * sends the alias (from modelSettings[].name), and the gateway resolves it to
 * the real deployment before calling Foundry.
 */
export const ALIAS_TO_DEPLOYMENT: Record<string, string> = {
  "kimi-k2.7-code": "FW-Kimi-K2.7-Code",
  "gpt-5.3-codex": "gpt-5.3-codex",
  "deepseek-v4-pro": "DeepSeek-V4-Pro",
  codestral: "Codestral-2501",
  "mistral-small": "mistral-small-2503",
};

/** Resolve an alias to its Foundry deployment, or null if unknown. */
export function resolveDeployment(alias: string): string | null {
  return ALIAS_TO_DEPLOYMENT[alias] ?? null;
}
