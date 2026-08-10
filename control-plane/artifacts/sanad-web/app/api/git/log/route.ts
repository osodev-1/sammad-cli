import { NextRequest } from "next/server";
import {
  authenticateWorkspace,
  relayJson,
  workspaceFetch,
} from "@/lib/workspace/proxy";

/** Recent commits (History timeline: pass path=.sanad to scope to the blueprint). */
export async function GET(req: NextRequest) {
  const gate = await authenticateWorkspace();
  if (!gate.ok) return gate.response;
  const sessionId = req.nextUrl.searchParams.get("session") ?? undefined;
  const limit = req.nextUrl.searchParams.get("limit") ?? "50";
  const path = req.nextUrl.searchParams.get("path");
  const qs = `limit=${encodeURIComponent(limit)}${path ? `&path=${encodeURIComponent(path)}` : ""}`;
  const upstream = await workspaceFetch(
    gate.userId,
    `/internal/git/log?${qs}`,
    {
      sessionId,
    },
  );
  return relayJson(upstream);
}
