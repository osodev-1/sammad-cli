import { NextRequest } from "next/server";
import { authenticateWorkspace, relayJson, workspaceFetch } from "@/lib/workspace/proxy";

/** Full validation report for the active project session's blueprint. */
export async function POST(req: NextRequest) {
  const gate = await authenticateWorkspace();
  if (!gate.ok) return gate.response;
  const sessionId = req.nextUrl.searchParams.get("session") ?? undefined;
  const upstream = await workspaceFetch(gate.userId, "/internal/blueprint/validate", {
    sessionId,
    method: "POST",
  });
  return relayJson(upstream);
}
