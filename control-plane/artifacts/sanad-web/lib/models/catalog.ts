export const MODEL_CATALOG = [
  { name: "kimi-k2.7-code", maxContextSize: 256000, capabilities: ["thinking"] },
  { name: "gpt-5.3-codex", maxContextSize: 200000, capabilities: [] },
  { name: "deepseek-v4-pro", maxContextSize: 128000, capabilities: ["thinking"] },
  { name: "codestral", maxContextSize: 256000, capabilities: [] },
  { name: "mistral-small", maxContextSize: 128000, capabilities: [] },
] as const;

export const DEFAULT_MODEL_ALIAS = "kimi-k2.7-code";

export const ALIAS_TO_DEPLOYMENT: Record<string, string> = {
  "kimi-k2.7-code": "FW-Kimi-K2.7-Code",
  "gpt-5.3-codex": "gpt-5.3-codex",
  "deepseek-v4-pro": "DeepSeek-V4-Pro",
  "codestral": "Codestral-2501",
  "mistral-small": "mistral-small-2503",
};
