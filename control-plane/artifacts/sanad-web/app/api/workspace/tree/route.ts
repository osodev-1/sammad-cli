import { NextRequest } from "next/server";
import { authenticateWorkspace, relayJson, workspaceFetch } from "@/lib/workspace/proxy";

export async function GET(req: NextRequest) {
  const gate = await authenticateWorkspace();
  if (!gate.ok) return gate.response;
  const path = req.nextUrl.searchParams.get("path") ?? "";
  const upstream = await workspaceFetch(
    gate.userId,
    `/internal/workspace/tree?path=${encodeURIComponent(path)}`
  );
  return relayJson(upstream);
}
