import { NextRequest } from "next/server";
import { authenticateWorkspace, relayStream, workspaceFetch } from "@/lib/workspace/proxy";

export async function POST(req: NextRequest) {
  const gate = await authenticateWorkspace();
  if (!gate.ok) return gate.response;
  const body = await req.text();
  const upstream = await workspaceFetch(gate.userId, "/internal/workspace/archive", {
    method: "POST",
    body: body || "{}",
    headers: { "content-type": "application/json" },
  });
  return relayStream(upstream, "attachment");
}
