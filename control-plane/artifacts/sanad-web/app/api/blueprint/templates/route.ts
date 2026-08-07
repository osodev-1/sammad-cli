import { NextRequest } from "next/server";
import { authenticateWorkspace, relayJson, workspaceFetch } from "@/lib/workspace/proxy";

export async function GET(req: NextRequest) {
  const gate = await authenticateWorkspace();
  if (!gate.ok) return gate.response;
  const sessionId = req.nextUrl.searchParams.get("session") ?? undefined;
  const upstream = await workspaceFetch(gate.userId, "/internal/blueprint/templates", { sessionId });
  return relayJson(upstream);
}
