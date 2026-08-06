import { authenticateWorkspace, relayJson, workspaceFetch } from "@/lib/workspace/proxy";

export async function GET() {
  const gate = await authenticateWorkspace();
  if (!gate.ok) return gate.response;
  const upstream = await workspaceFetch(gate.userId, "/internal/workspace/snapshot");
  return relayJson(upstream);
}
