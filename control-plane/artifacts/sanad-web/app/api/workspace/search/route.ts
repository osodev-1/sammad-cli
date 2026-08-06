import { NextRequest } from "next/server";
import { authenticateWorkspace, relayJson, workspaceFetch } from "@/lib/workspace/proxy";

export async function GET(req: NextRequest) {
  const gate = await authenticateWorkspace();
  if (!gate.ok) return gate.response;
  const q = req.nextUrl.searchParams.get("q") ?? "";
  const upstream = await workspaceFetch(
    gate.userId,
    `/internal/workspace/search?q=${encodeURIComponent(q)}`
  );
  return relayJson(upstream);
}
