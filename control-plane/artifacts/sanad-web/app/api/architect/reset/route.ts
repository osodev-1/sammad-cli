import { NextRequest } from "next/server";
import {
  authenticateWorkspace,
  relayJson,
  workspaceFetch,
} from "@/lib/workspace/proxy";

/** Stop the architect subprocess — the next start spawns fresh (fresh auth). */
export async function POST(req: NextRequest) {
  const gate = await authenticateWorkspace();
  if (!gate.ok) return gate.response;
  const sessionId = req.nextUrl.searchParams.get("session") ?? undefined;
  const upstream = await workspaceFetch(
    gate.userId,
    "/internal/architect/reset",
    {
      sessionId,
      method: "POST",
    },
  );
  return relayJson(upstream);
}
