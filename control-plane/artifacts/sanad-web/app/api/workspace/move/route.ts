import { NextRequest } from "next/server";
import { authenticateWorkspace, relayJson, workspaceFetch } from "@/lib/workspace/proxy";

export async function PATCH(req: NextRequest) {
  const gate = await authenticateWorkspace();
  if (!gate.ok) return gate.response;
  const body = await req.text();
  const upstream = await workspaceFetch(gate.userId, "/internal/workspace/move", {
    method: "PATCH",
    body,
    headers: { "content-type": "application/json" },
  });
  return relayJson(upstream);
}
