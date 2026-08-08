import { auth, currentUser } from "@clerk/nextjs/server";
import { and, eq } from "drizzle-orm";
import { ok, err } from "@/lib/http/envelope";
import { db } from "@/lib/db";
import { memberships } from "@/lib/db/schema";
import { requireEntitled } from "@/lib/auth/entitlement";
import { isTerminalAllowed } from "@/lib/auth/terminal";
import { mintTerminalTicket } from "@/lib/auth/terminal-tickets";
import { provisionPersonalOrg } from "@/lib/clerk/provisioning";
import { computeMode } from "@/lib/compute/mode";
import { ensureSessionTask, getOrCreateMainSession, getSession } from "@/lib/compute/sessions";

/**
 * Browser-facing: mint a one-time terminal ticket for the signed-in user.
 * The ticket (never the CLI session token) goes to the browser; the terminal
 * service redeems it server-to-server. Mirrors the device-approve gate:
 * provisioning, personal-org fallback, entitlement.
 */
export async function POST(req: Request) {
  const { userId, orgId } = await auth();
  if (!userId) {
    return err(401, "unauthorized", "Must be signed in to open a terminal");
  }
  const body = (await req.json().catch(() => null)) as { sessionId?: string } | null;
  const requestedSession = body?.sessionId;

  const clerkUser = await currentUser();
  const email = clerkUser?.emailAddresses[0]?.emailAddress ?? "";
  if (!isTerminalAllowed(email)) {
    return err(
      403,
      "terminal_not_enabled",
      "The web terminal is not enabled for this account"
    );
  }

  // Ensure the user is provisioned (idempotent)
  await provisionPersonalOrg({
    id: userId,
    email,
    displayName:
      clerkUser?.firstName && clerkUser?.lastName
        ? `${clerkUser.firstName} ${clerkUser.lastName}`
        : clerkUser?.firstName ?? undefined,
  });

  // A Clerk-active organization that was never provisioned here (no membership
  // row) must not gate the terminal — fall back to the personal org, which
  // provisionPersonalOrg just guaranteed exists.
  const personalOrgId = `personal_${userId}`;
  let activeOrgId = orgId ?? personalOrgId;
  if (activeOrgId !== personalOrgId) {
    const [member] = await db
      .select()
      .from(memberships)
      .where(
        and(
          eq(memberships.orgId, activeOrgId),
          eq(memberships.userId, userId)
        )
      )
      .limit(1);
    if (!member) activeOrgId = personalOrgId;
  }

  const ent = await requireEntitled(activeOrgId, userId);
  if (!ent.ok) {
    const reason = ent.reason === "no_plan" ? "no_plan" : "no_seat";
    const message =
      ent.reason === "no_plan"
        ? "No active subscription — visit /pricing to upgrade"
        : "No seat assigned — ask your admin to assign a seat";
    return err(403, reason, message);
  }

  let wsUrl: string;
  let coldStart = false;
  let sessionId: string | undefined;
  if (computeMode() === "aws") {
    // Ensure the SESSION's machine FIRST; the 60s ticket is minted last so
    // its whole TTL is spent on the browser's connect, never on a cold start.
    try {
      const session = requestedSession
        ? await getSession(userId, requestedSession)
        : await getOrCreateMainSession(userId);
      if (!session) return err(404, "unknown_session", "No such session");
      const target = await ensureSessionTask(userId, session.id);
      wsUrl = target.wsUrl;
      coldStart = target.coldStart;
      sessionId = session.id;
    } catch (e) {
      console.error("workspace provisioning failed", e);
      return err(503, "terminal_unavailable", "Could not start your workspace", true);
    }
  } else {
    const configured = process.env.TERMINAL_WS_URL;
    if (!configured) {
      return err(503, "terminal_unavailable", "Terminal service is not configured");
    }
    wsUrl = configured;
  }

  // `sessionId` (aws mode) is the workspace project the CLI session is born in;
  // it stamps usage attribution onto the session. Undefined in railway/legacy
  // mode, where there is no project — attribution stays null there.
  const { ticket, expiresIn } = await mintTerminalTicket(
    userId,
    activeOrgId,
    sessionId
  );
  return ok({ ticket, wsUrl, expiresIn, coldStart, sessionId });
}
