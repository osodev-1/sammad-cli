/**
 * RunPod proxy. Holds the RunPod API key and forwards an OpenAI-compatible
 * chat/completions request to a RunPod endpoint's OpenAI route. The URL pattern
 * is identical for RunPod **Public Endpoints** (slug = the public slug, e.g.
 * "moonshot-kimi") and your **own serverless endpoints** (slug = the endpoint
 * id): https://api.runpod.ai/v2/{slug}/openai/v1/chat/completions.
 */

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} environment variable is required`);
  return value;
}

const RUNPOD_BASE = (process.env.RUNPOD_BASE_URL ?? "https://api.runpod.ai/v2").replace(
  /\/+$/,
  ""
);

/**
 * Forward a chat/completions call to a RunPod endpoint. `slug` selects the
 * endpoint, `model` is the model name RunPod expects; `body` is the request the
 * CLI sent (messages, tools, stream, …) with `model` swapped in. Returns the raw
 * upstream Response so the caller can stream it straight back to the CLI.
 */
export function runpodChatCompletions(
  slug: string,
  model: string,
  body: Record<string, unknown>
): Promise<Response> {
  const apiKey = requireEnv("RUNPOD_API_KEY");
  const url = `${RUNPOD_BASE}/${slug}/openai/v1/chat/completions`;

  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ ...body, model }),
  });
}
