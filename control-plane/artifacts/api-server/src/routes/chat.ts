import { Router, type IRouter, type Request, type Response } from "express";
import { validateRuntimeToken } from "../lib/runtime-token";
import { resolveTarget } from "../lib/models";
import { runpodChatCompletions } from "../lib/runpod";
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

/**
 * OpenAI-compatible chat/completions. The CLI (OpenAI SDK, base = gatewayBaseUrl
 * ending in /v1) sends the model *alias* in `model`; we authenticate the opaque
 * runtime token, resolve the alias to an Azure deployment, proxy to Foundry, and
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

  // 2. Resolve the alias to a Foundry deployment.
  const body = (req.body ?? {}) as Record<string, unknown>;
  const alias = typeof body.model === "string" ? body.model : "";
  const target = resolveTarget(alias);
  if (!target) {
    return sendError(res, 400, "model_not_found", `Unknown model: ${alias || "(none)"}`);
  }

  // 3. Proxy to RunPod (holds the RunPod API key).
  let upstream;
  try {
    upstream = await runpodChatCompletions(target.slug, target.model, body);
  } catch (err) {
    logger.error({ err, alias }, "runpod request failed");
    return sendError(res, 502, "upstream_unreachable", "Model provider unreachable", "api_error");
  }

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => "");
    logger.error(
      { status: upstream.status, detail: detail.slice(0, 500), alias, slug: target.slug },
      "runpod returned an error"
    );
    // A 401/403 from Foundry means *our* key is wrong — not the caller's fault.
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
  // usage chunk (from stream_options.include_usage) for metering.
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const reader = upstream.body.getReader();
  res.on("close", () => void reader.cancel().catch(() => {}));

  const decoder = new TextDecoder();
  let sse = "";
  let usage: Usage | undefined;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value); // raw passthrough

      sse += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = sse.indexOf("\n\n")) !== -1) {
        const frame = sse.slice(0, sep);
        sse = sse.slice(sep + 2);
        const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
        if (!dataLine) continue;
        const data = dataLine.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        try {
          const chunk = JSON.parse(data) as { usage?: Usage | null };
          if (chunk.usage) usage = chunk.usage;
        } catch {
          /* partial / non-JSON frame — ignore */
        }
      }
    }
  } catch (err) {
    logger.error({ err, alias }, "stream relay error");
  } finally {
    res.end();
  }

  if (usage) {
    reportUsage(token, alias, usage.prompt_tokens ?? 0, usage.completion_tokens ?? 0);
  }
});

export default router;
