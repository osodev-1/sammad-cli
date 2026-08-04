import { and, eq, count } from "drizzle-orm";
import { db } from "../db";
import { memberships, subscriptions } from "../db/schema";

export type AdminCheck =
  | { ok: true }
  | { ok: false; status: number; error: string };

/** Roles allowed to manage seats and invites for an org. */
const ADMIN_ROLES = new Set(["owner", "admin"]);

/** Verify the user is an owner/admin member of the org. */
export async function requireOrgAdmin(
  orgId: string,
  userId: string
): Promise<AdminCheck> {
  const [membership] = await db
    .select()
    .from(memberships)
    .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, userId)))
    .limit(1);

  if (!membership) {
    return { ok: false, status: 403, error: "Not a member of this org" };
  }
  if (!ADMIN_ROLES.has(membership.role)) {
    return { ok: false, status: 403, error: "Admin role required" };
  }
  return { ok: true };
}

/** Verify the org has an active Team subscription; returns the row. */
export async function requireTeamSubscription(orgId: string) {
  const [sub] = await db
    .select()
    .from(subscriptions)
    .where(
      and(eq(subscriptions.orgId, orgId), eq(subscriptions.status, "active"))
    )
    .limit(1);

  if (!sub || sub.plan !== "team") return null;
  return sub;
}

/** Number of memberships currently holding a seat in the org. */
export async function countAssignedSeats(orgId: string): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(memberships)
    .where(
      and(eq(memberships.orgId, orgId), eq(memberships.seatAssigned, true))
    );
  return Number(row?.value ?? 0);
}
