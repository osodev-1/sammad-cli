import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import { memberships, users } from "../db/schema";
import type { PlanQuota } from "./plans";

/**
 * Comp (internal / negotiated) accounts.
 *
 * `SANAD_COMP_EMAILS` is a comma-separated allowlist of user emails whose org is
 * treated as fully entitled with an effectively-unlimited monthly allowance —
 * for dogfooding and comped deals that never touch Stripe. An org matches if ANY
 * of its members is on the list; comparison is case-insensitive.
 *
 * This is deliberately config- (not database-) driven: it lives in version
 * control, survives DB re-provisioning, and needs no manual row surgery on the
 * production billing tables.
 */
export function compEmails(): string[] {
  return (process.env.SANAD_COMP_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Effectively-unlimited monthly allowance for comped orgs. Large *finite*
 * numbers (not Infinity) so the usage math — remaining balance, percent used —
 * stays well-defined for the dashboard and the quota gate.
 */
export const COMP_QUOTA: PlanQuota = {
  requestsPerMonth: 1_000_000_000,
  tokensPerMonth: 1_000_000_000_000,
};

/**
 * True if `orgId` has a member on the comp allowlist.
 *
 * Short-circuits to `false` WITHOUT touching the database when the allowlist is
 * empty (the default), so the common non-comped path — every mint and renew —
 * pays no extra query cost, and unit tests that don't set the env var see no
 * additional `db` calls.
 */
export async function isOrgComped(orgId: string): Promise<boolean> {
  const emails = compEmails();
  if (emails.length === 0) return false;

  const rows = await db
    .select({ one: sql<number>`1` })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(
      and(
        eq(memberships.orgId, orgId),
        inArray(sql`lower(${users.email})`, emails)
      )
    )
    .limit(1);

  return rows.length > 0;
}
