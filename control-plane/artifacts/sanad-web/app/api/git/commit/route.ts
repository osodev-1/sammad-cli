import { NextRequest } from "next/server";
import { currentUser } from "@clerk/nextjs/server";
import { err } from "@/lib/http/envelope";
import {
  authenticateWorkspace,
  relayJson,
  workspaceFetch,
} from "@/lib/workspace/proxy";

/**
 * Commit the working tree. The author identity is resolved SERVER-SIDE from the
 * signed-in Clerk user — never taken from the browser body — so a commit's
 * author can't be spoofed by the client.
 */
export async function POST(req: NextRequest) {
  const gate = await authenticateWorkspace();
  if (!gate.ok) return gate.response;
  const sessionId = req.nextUrl.searchParams.get("session") ?? undefined;

  const body = (await req.json().catch(() => null)) as {
    message?: string;
  } | null;
  const message = body?.message?.trim();
  if (!message) return err(400, "invalid_request", "A commit needs a message");

  const clerkUser = await currentUser();
  const authorEmail =
    clerkUser?.emailAddresses[0]?.emailAddress ?? "workspace@sanadcode.com";
  const authorName =
    (clerkUser?.firstName && clerkUser?.lastName
      ? `${clerkUser.firstName} ${clerkUser.lastName}`
      : (clerkUser?.firstName ?? clerkUser?.username)) || "Sanad Workspace";

  const upstream = await workspaceFetch(gate.userId, "/internal/git/commit", {
    sessionId,
    method: "POST",
    body: JSON.stringify({ message, authorName, authorEmail }),
    headers: { "content-type": "application/json" },
  });
  return relayJson(upstream);
}
