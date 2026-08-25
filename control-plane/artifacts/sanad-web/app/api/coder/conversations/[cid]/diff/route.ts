import { NextRequest } from "next/server";
import { err } from "@/lib/http/envelope";
import {
  authenticateCoderPanel,
  relayJson,
  workspaceFetch,
} from "@/lib/workspace/proxy";

/** One turn's checkpoint diff: name-status + unified patch, `pre..post` once
 * finished or `pre..worktree` while still running (server-decided). */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ cid: string }> }
) {
  const gate = await authenticateCoderPanel();
  if (!gate.ok) return gate.response;
  const { cid } = await params;
  const sessionId = req.nextUrl.searchParams.get("session") ?? undefined;
  const turnId = req.nextUrl.searchParams.get("turnId");
  if (!turnId) return err(400, "invalid_request", "turnId required");
  const path = req.nextUrl.searchParams.get("path");
  const qs = `turnId=${encodeURIComponent(turnId)}${path ? `&path=${encodeURIComponent(path)}` : ""}`;
  const upstream = await workspaceFetch(
    gate.userId,
    `/internal/coder/conversations/${encodeURIComponent(cid)}/diff?${qs}`,
    { sessionId },
  );
  return relayJson(upstream);
}
