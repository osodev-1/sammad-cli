import { NextRequest } from "next/server";
import { err } from "@/lib/http/envelope";
import {
  authenticateWorkspace,
  relayJson,
  workspaceFetch,
} from "@/lib/workspace/proxy";

/** One commit's unified diff (expandable history entry). */
export async function GET(req: NextRequest) {
  const gate = await authenticateWorkspace();
  if (!gate.ok) return gate.response;
  const sessionId = req.nextUrl.searchParams.get("session") ?? undefined;
  const ref = req.nextUrl.searchParams.get("ref");
  if (!ref) return err(400, "invalid_request", "ref required");
  const path = req.nextUrl.searchParams.get("path");
  const qs = `ref=${encodeURIComponent(ref)}${path ? `&path=${encodeURIComponent(path)}` : ""}`;
  const upstream = await workspaceFetch(
    gate.userId,
    `/internal/git/show?${qs}`,
    {
      sessionId,
    },
  );
  return relayJson(upstream);
}
