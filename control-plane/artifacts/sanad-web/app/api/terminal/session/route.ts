import { auth, currentUser } from "@clerk/nextjs/server";
import { and, eq } from "drizzle-orm";
import { ok, err } from "@/lib/http/envelope";
import { db } from "@/lib/db";
import { memberships } from "@/lib/db/schema";
import { requireEntitled } from "@/lib/auth/entitlement";
import { isTerminalAllowed } from "@/lib/auth/terminal";
import { mintTerminalTicket } from "@/lib/auth/terminal-tickets";
import { provisionPersonalOrg } from "@/lib/clerk/provisioning";

/**
 * Browser-facing: mint a one-time terminal ticket for the signed-in user.
 * The ticket (never the CLI session token) goes to the browser; the terminal
 * service redeems it server-to-server. Mirrors the device-approve gate:
 * provisioning, personal-org fallback, entitlement.
 */
export async function POST() {
  const { userId, orgId } = await auth();
  if (!userId) {
    return err(401, "unauthorized", "Must be signed in to open a terminal");
  }

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

  const wsUrl = process.env.TERMINAL_WS_URL;
  if (!wsUrl) {
    return err(503, "terminal_unavailable", "Terminal service is not configured");
  }

  const { ticket, expiresIn } = await mintTerminalTicket(userId, activeOrgId);
  return ok({ ticket, wsUrl, expiresIn });
}
