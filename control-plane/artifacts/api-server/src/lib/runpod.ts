/**
 * Upstream chat/completions. Default leg: the RunPod proxy — holds the RunPod
 * API key and forwards an OpenAI-compatible request to a RunPod endpoint's
 * OpenAI route. The URL pattern is identical for RunPod **Public Endpoints**
 * (slug = the public slug, e.g. "moonshot-kimi") and your **own serverless
 * endpoints** (slug = the endpoint id):
 * https://api.runpod.ai/v2/{slug}/openai/v1/chat/completions.
 *
 * KNOWN LIMIT (hh validation 2026-08-14): RunPod's sync /openai route cuts
 * every streamed response at ~300s TOTAL, mid-stream, data flowing or not —
 * long-thinking turns can never finish a >5-minute model call through it.
 * The escape hatch is a per-alias env override (see `envOverride`) pointing
 * at any OpenAI-compatible provider; this module routes to it when set.
 *
 * Residual (documented, not fixed here): Node fetch (undici) defaults cap
 * time-to-first-byte and idle-between-chunks at 300s each. Neither cuts an
 * actively-streaming response, so they are not the 300s-total culprit — but a
 * provider that stays silent >5min (cold start, or non-streamed reasoning)
 * still times out client-side. The relay's end-of-stream logging in
 * routes/chat.ts makes that case legible if it ever appears.
 */

import type { RunpodTarget, UpstreamOverride } from "./models";
import { envOverride } from "./models";

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

/** Forward to an env-overridden OpenAI-compatible base URL (the uncapped leg). */
function overrideChatCompletions(
  override: UpstreamOverride,
  model: string,
  body: Record<string, unknown>
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (override.apiKey) headers.authorization = `Bearer ${override.apiKey}`;

  return fetch(`${override.baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ...body, model: override.model ?? model }),
  });
}

/**
 * The single upstream entry point: env override when configured for the alias,
 * RunPod otherwise. Returns the raw Response plus which leg served it (for the
 * relay's end-of-stream forensics).
 */
export function upstreamChatCompletions(
  alias: string,
  target: RunpodTarget,
  body: Record<string, unknown>
): { upstream: Promise<Response>; leg: "override" | "runpod" } {
  const override = envOverride(alias);
  if (override) {
    return { upstream: overrideChatCompletions(override, target.model, body), leg: "override" };
  }
  return { upstream: runpodChatCompletions(target.slug, target.model, body), leg: "runpod" };
}
