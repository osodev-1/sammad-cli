import { NextRequest } from "next/server";
import {
  authenticateCoderPanel,
  relayJson,
  workspaceFetch,
} from "@/lib/workspace/proxy";

/** Switch the live permission mode on the agent's wire. */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ cid: string }> }
) {
  const gate = await authenticateCoderPanel();
  if (!gate.ok) return gate.response;
  const { cid } = await params;
  const sessionId = req.nextUrl.searchParams.get("session") ?? undefined;
  const body = await req.text();
  const upstream = await workspaceFetch(
    gate.userId,
    `/internal/coder/conversations/${encodeURIComponent(cid)}/mode`,
    {
      sessionId,
      method: "POST",
      body: body || "{}",
      headers: { "content-type": "application/json" },
    },
  );
  return relayJson(upstream);
}
