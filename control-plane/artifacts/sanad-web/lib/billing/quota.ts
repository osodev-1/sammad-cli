/**
 * Database-backed usage aggregation and the server-side quota gate.
 *
 * This is the single place that answers "how much has this org used, and is it
 * still allowed to run?". The dashboard and the runtime-token gate both call
 * it, so what a user is shown and what the API enforces cannot drift apart.
 */
import { and, count, eq, gte, sum } from "drizzle-orm";
import { db } from "../db";
import { subscriptions, usageEvents } from "../db/schema";
import { resolveQuota } from "./plans";
import { isOrgComped, COMP_QUOTA } from "./comp";
import { computeUsage, type UsageDimension, type UsageStatus } from "./usage";

/**
 * First moment of the org's current billing period.
 *
 * Stripe only gives us the period END, so we step back a month from it. Free
 * orgs have no Stripe period at all and fall back to the calendar month.
 * Without this window the meter sums usage for all time and the remaining
 * balance never resets.
 */
export function startOfPeriod(periodEnd: Date | null): Date {
  if (periodEnd) {
    const start = new Date(periodEnd);
    const targetDay = start.getDate();
    /*
     * Snap to the 1st before shifting the month. Calling setMonth() directly on
     * e.g. 31 March asks for "31 February", which JS rolls FORWARD into March
     * again — the window would then cover a couple of days instead of a month
     * and silently hide most of the period's usage. After the shift, clamp the
     * day to the target month's length.
     */
    start.setDate(1);
    start.setMonth(start.getMonth() - 1);
    const daysInTargetMonth = new Date(
      start.getFullYear(),
      start.getMonth() + 1,
      0
    ).getDate();
    start.setDate(Math.min(targetDay, daysInTargetMonth));
    return start;
  }
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

export interface ModelUsageRow {
  alias: string;
  requests: number;
  tokensIn: number;
  tokensOut: number;
}

export interface OrgUsage {
  plan: string;
  status: UsageStatus;
  periodStart: Date;
  currentPeriodEnd: Date | null;
  hasStripeCustomer: boolean;
  byModel: ModelUsageRow[];
}

/** Aggregate an org's usage for the current billing period. */
export async function getOrgUsage(orgId: string): Promise<OrgUsage> {
  const [sub] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.orgId, orgId))
    .limit(1);

  const plan = sub?.plan ?? "free";
  // Comped orgs get an effectively-unlimited allowance regardless of their
  // (possibly missing) subscription row, so the meter never gates them.
  const limits = (await isOrgComped(orgId))
    ? COMP_QUOTA
    : resolveQuota(plan, sub?.quota);
  const periodStart = startOfPeriod(sub?.currentPeriodEnd ?? null);

  const rows = await db
    .select({
      modelAlias: usageEvents.modelAlias,
      requests: count(usageEvents.id),
      tokensIn: sum(usageEvents.tokensIn),
      tokensOut: sum(usageEvents.tokensOut),
    })
    .from(usageEvents)
    .where(
      and(
        eq(usageEvents.orgId, orgId),
        gte(usageEvents.createdAt, periodStart)
      )
    )
    .groupBy(usageEvents.modelAlias);

  const byModel: ModelUsageRow[] = rows.map((r) => ({
    alias: r.modelAlias,
    requests: Number(r.requests ?? 0),
    tokensIn: Number(r.tokensIn ?? 0),
    tokensOut: Number(r.tokensOut ?? 0),
  }));

  const requestsUsed = byModel.reduce((a, r) => a + r.requests, 0);
  const tokensUsed = byModel.reduce((a, r) => a + r.tokensIn + r.tokensOut, 0);

  return {
    plan,
    status: computeUsage({
      requestsUsed,
      requestsLimit: limits.requestsPerMonth,
      tokensUsed,
      tokensLimit: limits.tokensPerMonth,
    }),
    periodStart,
    currentPeriodEnd: sub?.currentPeriodEnd ?? null,
    hasStripeCustomer: Boolean(sub?.stripeCustomerId),
    byModel,
  };
}

export class QuotaExceededError extends Error {
  constructor(
    public readonly dimension: UsageDimension,
    public readonly status: UsageStatus
  ) {
    super(`Quota exceeded: ${dimension}`);
    this.name = "QuotaExceededError";
  }
}

/**
 * Throw if the org has exhausted either allowance.
 *
 * Called at runtime-token mint and renew — the chokepoint for gateway access.
 * Enforcing at renew as well as mint matters: a 10-minute token would
 * otherwise keep working for the rest of its 24h absolute window after the
 * org ran out.
 *
 * Two deliberate operational properties:
 *
 * - FAIL-CLOSED. A database error propagates and the caller gets a 500, so no
 *   token is issued. Billing integrity is preferred over availability here; the
 *   cost is that a DB incident suspends new CLI runs rather than letting them
 *   through unmetered.
 * - Aggregate-then-decide is not transactional, so concurrent requests can
 *   overshoot the cap slightly. That window is bounded by the short token TTL
 *   and the re-check on renew, and is accepted rather than serialised — taking
 *   a lock per mint would cost far more than the small overage it prevents.
 */
export async function assertWithinQuota(orgId: string): Promise<void> {
  const { status } = await getOrgUsage(orgId);
  if (!status.isExceeded) return;

  const dimension: UsageDimension =
    status.requests.remaining <= 0 ? "requests" : "tokens";
  throw new QuotaExceededError(dimension, status);
}
