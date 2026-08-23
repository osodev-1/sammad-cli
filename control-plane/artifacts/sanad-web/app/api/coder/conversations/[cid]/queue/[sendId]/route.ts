import { NextRequest } from "next/server";
import {
  authenticateCoderPanel,
  relayJson,
  workspaceFetch,
} from "@/lib/workspace/proxy";

/** Remove a not-yet-started queued follow-up (P4b). */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ cid: string; sendId: string }> }
) {
  const gate = await authenticateCoderPanel();
  if (!gate.ok) return gate.response;
  const { cid, sendId } = await params;
  const sessionId = req.nextUrl.searchParams.get("session") ?? undefined;
  const upstream = await workspaceFetch(
    gate.userId,
    `/internal/coder/conversations/${encodeURIComponent(cid)}/queue/${encodeURIComponent(sendId)}`,
    {
      sessionId,
      method: "DELETE",
    },
  );
  return relayJson(upstream);
}
