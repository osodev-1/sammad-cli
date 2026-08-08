import { NextRequest } from "next/server";
import {
  authenticateWorkspace,
  relayJson,
  workspaceFetch,
} from "@/lib/workspace/proxy";

export async function POST(req: NextRequest) {
  const gate = await authenticateWorkspace();
  if (!gate.ok) return gate.response;
  const sessionId = req.nextUrl.searchParams.get("session") ?? undefined;
  const upstream = await workspaceFetch(
    gate.userId,
    "/internal/architect/cancel",
    {
      sessionId,
      method: "POST",
      headers: { "content-type": "application/json" },
    },
  );
  return relayJson(upstream);
}
