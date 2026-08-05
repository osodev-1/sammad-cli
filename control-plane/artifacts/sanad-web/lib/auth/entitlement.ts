import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { subscriptions, memberships, organizations } from "../db/schema";
import { isOrgComped } from "../billing/comp";

export type EntitlementResult =
  | { ok: true }
  | { ok: false; reason: "no_plan" | "no_seat" };

/**
 * Checks whether an org + user is entitled to mint a runtime token.
 * - Personal (free) orgs → always entitled while subscription is active.
 * - Team/enterprise orgs → org must have an active subscription AND the
 *   membership must have seatAssigned = true.
 */
export async function requireEntitled(
  orgId: string,
  userId: string
): Promise<EntitlementResult> {
  // Comp / internal accounts (SANAD_COMP_EMAILS) are entitled unconditionally —
  // no Stripe subscription required. Checked first so a comped org is never
  // gated on the presence of an active subscription row.
  if (await isOrgComped(orgId)) return { ok: true };

  // Fetch org type
  const [org] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  // Fetch active subscription
  const [sub] = await db
    .select()
    .from(subscriptions)
    .where(
      and(eq(subscriptions.orgId, orgId), eq(subscriptions.status, "active"))
    )
    .limit(1);

  if (!sub) return { ok: false, reason: "no_plan" };

  // Personal free orgs: subscription active → entitled
  if (org?.type === "personal") return { ok: true };

  // Team/enterprise: require seat
  const [membership] = await db
    .select()
    .from(memberships)
    .where(
      and(
        eq(memberships.orgId, orgId),
        eq(memberships.userId, userId),
        eq(memberships.seatAssigned, true)
      )
    )
    .limit(1);

  if (!membership) return { ok: false, reason: "no_seat" };

  return { ok: true };
}
