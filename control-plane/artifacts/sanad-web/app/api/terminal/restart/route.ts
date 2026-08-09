import { NextRequest } from "next/server";
import { authenticateWorkspace, relayJson, workspaceFetch } from "@/lib/workspace/proxy";

/**
 * Restart the workspace's agent sessions (S9 activation). Kills the machine's
 * AGENT PTYs; the panels then reconnect and the fresh spawn resumes the newest
 * conversation from disk — same chat, freshly loaded (trust-gated) skills.
 */
export async function POST(req: NextRequest) {
  const gate = await authenticateWorkspace();
  if (!gate.ok) return gate.response;
  const sessionId = req.nextUrl.searchParams.get("session") ?? undefined;
  const upstream = await workspaceFetch(gate.userId, "/internal/terminal/restart", {
    sessionId,
    method: "POST",
  });
  return relayJson(upstream);
}
