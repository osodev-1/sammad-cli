import { NextRequest } from "next/server";
import {
  authenticateCoderPanel,
  relayJson,
  workspaceFetch,
} from "@/lib/workspace/proxy";

/** List live conversations for this workspace. */
export async function GET(req: NextRequest) {
  const gate = await authenticateCoderPanel();
  if (!gate.ok) return gate.response;
  const sessionId = req.nextUrl.searchParams.get("session") ?? undefined;
  const upstream = await workspaceFetch(gate.userId, "/internal/coder/conversations", {
    sessionId,
  });
  return relayJson(upstream);
}

/** Create a new conversation — redeems a one-time ticket, spawns the agent. */
export async function POST(req: NextRequest) {
  const gate = await authenticateCoderPanel();
  if (!gate.ok) return gate.response;
  const sessionId = req.nextUrl.searchParams.get("session") ?? undefined;
  const body = await req.text();
  const upstream = await workspaceFetch(
    gate.userId,
    "/internal/coder/conversations",
    {
      sessionId,
      method: "POST",
      body: body || "{}",
      headers: { "content-type": "application/json" },
    },
  );
  return relayJson(upstream);
}
