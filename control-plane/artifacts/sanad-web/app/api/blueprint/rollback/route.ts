import { NextRequest } from "next/server";
import { currentUser } from "@clerk/nextjs/server";
import {
  authenticateWorkspace,
  relayJson,
  workspaceFetch,
} from "@/lib/workspace/proxy";

/** Revert a transaction; the revert's auto-commit carries the user's identity. */
export async function POST(req: NextRequest) {
  const gate = await authenticateWorkspace();
  if (!gate.ok) return gate.response;
  const sessionId = req.nextUrl.searchParams.get("session") ?? undefined;
  const body = await req.text();

  const clerkUser = await currentUser();
  const authorEmail =
    clerkUser?.emailAddresses[0]?.emailAddress ?? "workspace@sanadcode.com";
  const authorName =
    (clerkUser?.firstName && clerkUser?.lastName
      ? `${clerkUser.firstName} ${clerkUser.lastName}`
      : (clerkUser?.firstName ?? clerkUser?.username)) || "Sanad Workspace";

  const upstream = await workspaceFetch(
    gate.userId,
    "/internal/blueprint/rollback",
    {
      sessionId,
      method: "POST",
      body: body || "{}",
      headers: {
        "content-type": "application/json",
        "x-author-name": authorName,
        "x-author-email": authorEmail,
      },
    },
  );
  return relayJson(upstream);
}
