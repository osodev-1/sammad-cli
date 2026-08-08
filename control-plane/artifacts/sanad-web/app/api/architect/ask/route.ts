import { NextRequest } from "next/server";
import {
  authenticateWorkspace,
  relayJson,
  workspaceFetch,
} from "@/lib/workspace/proxy";

/**
 * Relay one architect turn as a stream. agentd answers with newline-delimited
 * JSON (an event per line, ending in a turn-end marker); we pass the body
 * straight through so the browser renders the turn as it arrives. Non-2xx
 * (409 busy / not_started) comes back as a normal JSON error instead.
 */
export async function POST(req: NextRequest) {
  const gate = await authenticateWorkspace();
  if (!gate.ok) return gate.response;
  const sessionId = req.nextUrl.searchParams.get("session") ?? undefined;
  const body = await req.text();
  const upstream = await workspaceFetch(
    gate.userId,
    "/internal/architect/ask",
    {
      sessionId,
      method: "POST",
      body: body || "{}",
      headers: { "content-type": "application/json" },
    },
  );
  if (!upstream.ok || !upstream.body) return relayJson(upstream);
  return new Response(upstream.body, {
    status: 200,
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "x-content-type-options": "nosniff",
      "cache-control": "no-cache, no-transform",
    },
  });
}
