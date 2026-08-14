import { Router, type IRouter, type Request, type Response } from "express";
import { validateRuntimeToken } from "../lib/runtime-token";
import { resolveTarget } from "../lib/models";
import { upstreamChatCompletions } from "../lib/runpod";
import { reportUsage } from "../lib/usage";
import { logger } from "../lib/logger";

const router: IRouter = Router();

/** OpenAI-style error body, so the CLI's OpenAI SDK surfaces it correctly. */
function sendError(
  res: Response,
  status: number,
  code: string,
  message: string,
  type = "invalid_request_error"
): void {
  res.status(status).json({ error: { message, type, code } });
}

function bearer(req: Request): string {
  const h = req.headers.authorization;
  return h?.startsWith("Bearer ") ? h.slice(7).trim() : "";
}

interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

/** SSE comment cadence while the upstream is quiet. Railway's edge closes a
 * response after 5 minutes with NO data transfer (its 15-minute TOTAL cap is
 * not something a heartbeat can extend); comment lines are ignored by every
 * SSE parser, so quiet upstream stretches no longer kill the CLI leg. */
const HEARTBEAT_MS = 15_000;

/**
 * OpenAI-compatible chat/completions. The CLI (OpenAI SDK, base = gatewayBaseUrl
 * ending in /v1) sends the model *alias* in `model`; we authenticate the opaque
 * runtime token, resolve the alias to its upstream (env override or RunPod), and
 * relay the response — metering the served usage back to the control plane.
 */
router.post("/chat/completions", async (req: Request, res: Response) => {
  // 1. Authenticate the opaque runtime token against the shared Postgres.
  const token = bearer(req);
  if (!token) {
    return sendError(
      res,
      401,
      "missing_token",
      "Missing bearer token",
      "authentication_error"
    );
  }

  let identity;
  try {
    identity = await validateRuntimeToken(token);
  } catch (err) {
    logger.error({ err }, "runtime token validation failed");
    return sendError(res, 500, "internal_error", "Token validation failed", "api_error");
  }
  if (!identity) {
    return sendError(
      res,
      401,
      "invalid_token",
      "Invalid, expired, or revoked runtime token",
      "authentication_error"
    );
  }

  // 2. Resolve the alias to its upstream target.
  const body = (req.body ?? {}) as Record<string, unknown>;
  const alias = typeof body.model === "string" ? body.model : "";
  const target = resolveTarget(alias);
  if (!target) {
    return sendError(res, 400, "model_not_found", `Unknown model: ${alias || "(none)"}`);
  }

  // 3. Proxy upstream (env override when configured, RunPod otherwise —
  //    whichever leg, the API key lives here, never with the caller).
  const { upstream: upstreamPromise, leg } = upstreamChatCompletions(alias, target, body);
  let upstream;
  try {
    upstream = await upstreamPromise;
  } catch (err) {
    logger.error({ err, alias, leg }, "upstream request failed");
    return sendError(res, 502, "upstream_unreachable", "Model provider unreachable", "api_error");
  }

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => "");
    logger.error(
      { status: upstream.status, detail: detail.slice(0, 500), alias, leg, slug: target.slug },
      "upstream returned an error"
    );
    // A 401/403 upstream means *our* key is wrong — not the caller's fault.
    const status = upstream.status === 401 || upstream.status === 403 ? 502 : upstream.status;
    return sendError(res, status, "upstream_error", "Model provider returned an error", "api_error");
  }

  const contentType = upstream.headers.get("content-type") ?? "";

  // 4a. Non-streaming: forward the single JSON, then meter.
  if (!contentType.includes("text/event-stream")) {
    const json = (await upstream.json().catch(() => null)) as { usage?: Usage } | null;
    if (!json) {
      return sendError(res, 502, "upstream_error", "Malformed model provider response", "api_error");
    }
    res.status(200).json(json);
    if (json.usage) {
      reportUsage(token, alias, json.usage.prompt_tokens ?? 0, json.usage.completion_tokens ?? 0);
    }
    return;
  }

  // 4b. Streaming: relay the SSE straight to the CLI while capturing the final
  // usage chunk (from stream_options.include_usage) for metering. Every stream
  // logs how it ENDED — [DONE]/finish_reason = complete; client-closed = the
  // caller (or an edge in front of us) hung up; neither = the upstream cut us
  // mid-generation (RunPod's sync route does this at ~300s), in which case the
  // CLI gets an explicit OpenAI-style error frame instead of a silent
  // truncation it would mistake for a finished message.
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const startedAt = Date.now();
  let bytes = 0;
  let frames = 0;
  let sawDone = false;
  let finishReason: string | null = null;
  let clientClosed = false;

  const reader = upstream.body.getReader();
  res.on("close", () => {
    clientClosed = true;
    void reader.cancel().catch(() => {});
  });

  let lastWrite = Date.now();
  const heartbeat = setInterval(() => {
    if (Date.now() - lastWrite >= HEARTBEAT_MS && !res.writableEnded) {
      res.write(": keep-alive\n\n");
      lastWrite = Date.now();
    }
  }, HEARTBEAT_MS);

  const decoder = new TextDecoder();
  let sse = "";
  let usage: Usage | undefined;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value); // raw passthrough
      bytes += value.byteLength;
      lastWrite = Date.now();

      sse += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = sse.indexOf("\n\n")) !== -1) {
        const frame = sse.slice(0, sep);
        sse = sse.slice(sep + 2);
        const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
        if (!dataLine) continue;
        const data = dataLine.slice(5).trim();
        if (!data) continue;
        frames += 1;
        if (data === "[DONE]") {
          sawDone = true;
          continue;
        }
        try {
          const chunk = JSON.parse(data) as {
            usage?: Usage | null;
            choices?: Array<{ finish_reason?: string | null }>;
          };
          if (chunk.usage) usage = chunk.usage;
          const fr = chunk.choices?.[0]?.finish_reason;
          if (fr) finishReason = fr;
        } catch {
          /* partial / non-JSON frame — ignore */
        }
      }
    }
  } catch (err) {
    logger.error({ err, alias, leg }, "stream relay error");
  } finally {
    clearInterval(heartbeat);
    const durationMs = Date.now() - startedAt;
    const complete = sawDone || finishReason !== null;
    if (complete) {
      logger.info({ alias, leg, durationMs, bytes, frames, finishReason }, "stream complete");
    } else if (clientClosed) {
      logger.warn(
        { alias, leg, durationMs, bytes, frames },
        "stream client-closed before completion"
      );
    } else {
      logger.warn(
        { alias, leg, durationMs, bytes, frames },
        "upstream cut the stream before completion"
      );
      if (!res.writableEnded) {
        const seconds = Math.round(durationMs / 1000);
        res.write(
          `data: ${JSON.stringify({
            error: {
              message: `The model provider ended the stream unexpectedly after ${seconds}s.`,
              type: "api_error",
              code: "upstream_stream_cut",
            },
          })}\n\n`
        );
      }
    }
    res.end();
  }

  if (usage) {
    reportUsage(token, alias, usage.prompt_tokens ?? 0, usage.completion_tokens ?? 0);
  }
});

export default router;
