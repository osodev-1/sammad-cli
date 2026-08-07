import { NextRequest } from "next/server";
import { authenticateWorkspace, relayJson, workspaceFetch } from "@/lib/workspace/proxy";

/** The compiled blueprint graph for the active project session. */
export async function GET(req: NextRequest) {
  const gate = await authenticateWorkspace();
  if (!gate.ok) return gate.response;
  const sessionId = req.nextUrl.searchParams.get("session") ?? undefined;
  const upstream = await workspaceFetch(gate.userId, "/internal/blueprint/graph", { sessionId });
  return relayJson(upstream);
}
