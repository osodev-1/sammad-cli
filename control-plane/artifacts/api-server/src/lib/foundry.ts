/**
 * Azure AI Foundry proxy. Holds the Foundry API key (only here — never in the
 * CLI or the control plane) and forwards an OpenAI-compatible chat/completions
 * request to the unified Azure AI Model Inference endpoint, swapping the alias
 * in the body for the resolved deployment name.
 */

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} environment variable is required`);
  return value;
}

/**
 * Forward a chat/completions call to Foundry. `body` is the request the CLI
 * sent (messages, tools, stream, stream_options, …); only `model` is replaced
 * with the deployment. Returns the raw upstream Response so the caller can
 * stream it straight back to the CLI.
 */
export function foundryChatCompletions(
  deployment: string,
  body: Record<string, unknown>
): Promise<Response> {
  const endpoint = requireEnv("FOUNDRY_ENDPOINT").replace(/\/+$/, "");
  const apiKey = requireEnv("FOUNDRY_API_KEY");
  const apiVersion = process.env.FOUNDRY_API_VERSION ?? "2024-05-01-preview";

  const url = `${endpoint}/chat/completions?api-version=${encodeURIComponent(
    apiVersion
  )}`;

  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "api-key": apiKey,
    },
    body: JSON.stringify({ ...body, model: deployment }),
  });
}
