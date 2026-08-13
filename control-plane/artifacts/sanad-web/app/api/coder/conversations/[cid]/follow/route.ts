import { NextRequest } from "next/server";
import {
  authenticateCoderPanel,
  relayJson,
  workspaceFetch,
} from "@/lib/workspace/proxy";

/** Re-attach to a running turn: replay from a seq, then stream live. */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ cid: string }> }
) {
  const gate = await authenticateCoderPanel();
  if (!gate.ok) return gate.response;
  const { cid } = await params;
  const sessionId = req.nextUrl.searchParams.get("session") ?? undefined;
  const turnId = req.nextUrl.searchParams.get("turnId") ?? "";
  const fromSeq = req.nextUrl.searchParams.get("from_seq") ?? "0";
  const upstream = await workspaceFetch(
    gate.userId,
    `/internal/coder/conversations/${encodeURIComponent(cid)}/follow?turnId=${encodeURIComponent(turnId)}&from_seq=${encodeURIComponent(fromSeq)}`,
    { sessionId },
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
