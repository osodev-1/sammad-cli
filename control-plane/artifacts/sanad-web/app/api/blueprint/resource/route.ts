import { NextRequest } from "next/server";
import { err } from "@/lib/http/envelope";
import { authenticateWorkspace, relayJson, workspaceFetch } from "@/lib/workspace/proxy";

/** One blueprint resource: manifest, supporting files, diagnostics. */
export async function GET(req: NextRequest) {
  const gate = await authenticateWorkspace();
  if (!gate.ok) return gate.response;
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return err(400, "invalid_request", "Missing resource id");
  const sessionId = req.nextUrl.searchParams.get("session") ?? undefined;
  const upstream = await workspaceFetch(
    gate.userId,
    `/internal/blueprint/resource?id=${encodeURIComponent(id)}`,
    { sessionId }
  );
  return relayJson(upstream);
}
