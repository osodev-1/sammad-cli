import { NextRequest } from "next/server";
import {
  authenticateCoderPanel,
  relayJson,
  workspaceFetch,
} from "@/lib/workspace/proxy";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ cid: string }> }
) {
  const gate = await authenticateCoderPanel();
  if (!gate.ok) return gate.response;
  const { cid } = await params;
  const sessionId = req.nextUrl.searchParams.get("session") ?? undefined;
  const upstream = await workspaceFetch(
    gate.userId,
    `/internal/coder/conversations/${encodeURIComponent(cid)}/cancel`,
    {
      sessionId,
      method: "POST",
      headers: { "content-type": "application/json" },
    },
  );
  return relayJson(upstream);
}
