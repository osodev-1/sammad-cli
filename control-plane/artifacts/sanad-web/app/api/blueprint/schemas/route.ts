import { NextRequest } from "next/server";
import { authenticateWorkspace, relayJson, workspaceFetch } from "@/lib/workspace/proxy";

/** JSON Schema per resource kind — powers the web UI's create/edit forms. */
export async function GET(req: NextRequest) {
  const gate = await authenticateWorkspace();
  if (!gate.ok) return gate.response;
  const sessionId = req.nextUrl.searchParams.get("session") ?? undefined;
  const upstream = await workspaceFetch(gate.userId, "/internal/blueprint/schemas", { sessionId });
  return relayJson(upstream);
}
