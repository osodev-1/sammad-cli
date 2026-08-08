import { NextRequest } from "next/server";
import {
  authenticateWorkspace,
  relayJson,
  workspaceFetch,
} from "@/lib/workspace/proxy";

/** List a zip/tar archive's members (read-only viewer) — proxied to agentd. */
export async function GET(req: NextRequest) {
  const gate = await authenticateWorkspace();
  if (!gate.ok) return gate.response;
  const path = req.nextUrl.searchParams.get("path");
  if (!path) {
    return Response.json(
      { error: { code: "invalid_request", message: "path is required" } },
      { status: 400 },
    );
  }
  const sessionId = req.nextUrl.searchParams.get("session") ?? undefined;
  const upstream = await workspaceFetch(
    gate.userId,
    `/internal/workspace/archive-list?path=${encodeURIComponent(path)}`,
    { sessionId },
  );
  return relayJson(upstream);
}
