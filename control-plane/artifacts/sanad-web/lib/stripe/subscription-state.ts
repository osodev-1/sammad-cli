import { freePlanState, type Plan, type SubStatus } from "@/lib/billing/plans";

/** The subset of a Stripe Subscription object this module relies on. */
export interface StripeSubscriptionShape {
  id?: string;
  status?: string;
  current_period_end?: number | null;
  items?: {
    data?: Array<{
      current_period_end?: number | null;
      quantity?: number | null;
      price?: { id?: string } | null;
    }>;
  };
}

/**
 * Resolve the current period end from a Stripe subscription.
 *
 * Stripe moved `current_period_end` off the Subscription object and onto
 * subscription items in the 2025 API versions, so different events can carry
 * it in different places. Prefer the item-level value, fall back to the legacy
 * top-level field, and reject anything that is not a finite positive epoch so
 * an Invalid Date can never reach the database.
 */
export function resolvePeriodEnd(sub: StripeSubscriptionShape): Date | null {
  const candidates = [
    sub.items?.data?.[0]?.current_period_end,
    sub.current_period_end,
  ];

  for (const value of candidates) {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      continue;
    }
    const date = new Date(value * 1000);
    if (!Number.isNaN(date.getTime())) return date;
  }

  return null;
}

/** Seat count from the first subscription item, defaulting to a single seat. */
export function resolveSeats(sub: StripeSubscriptionShape): number {
  const quantity = sub.items?.data?.[0]?.quantity;
  return typeof quantity === "number" &&
    Number.isFinite(quantity) &&
    quantity > 0
    ? quantity
    : 1;
}

/** Collapse Stripe's status vocabulary onto our three-state column. */
export function mapStripeStatus(status: string | undefined): SubStatus {
  switch (status) {
    case "active":
    case "trialing":
      return "active";
    case "past_due":
    case "unpaid":
      return "past_due";
    default:
      return "canceled";
  }
}

export interface SubscriptionPatch {
  plan: Plan;
  status: SubStatus;
  seats: number;
  quota?: Record<string, number>;
  stripeSubscriptionId: string | null;
  currentPeriodEnd: Date | null;
}

/**
 * Decide what to store for a Stripe subscription lifecycle event.
 *
 * The invariant that matters: a subscription that has ended must come back as
 * an ACTIVE row on the free plan. Storing `status: "canceled"` would fail the
 * `requireEntitled()` lookup and strip the org of even free-tier access.
 *
 * `past_due` is deliberately preserved rather than downgraded — that org still
 * has a paid subscription which Stripe is retrying, and `invoice.paid` restores
 * it. Only a terminal cancellation falls back to free.
 */
export function nextSubscriptionState(params: {
  deleted: boolean;
  plan: Plan;
  sub: StripeSubscriptionShape;
  stripeSubscriptionId: string | null;
}): SubscriptionPatch {
  const status = params.deleted
    ? "canceled"
    : mapStripeStatus(params.sub.status);

  if (params.deleted || status === "canceled") {
    const free = freePlanState();
    return {
      plan: free.plan,
      status: free.status,
      seats: free.seats,
      quota: free.quota,
      stripeSubscriptionId: null,
      currentPeriodEnd: null,
    };
  }

  return {
    plan: params.plan,
    status,
    seats: resolveSeats(params.sub),
    stripeSubscriptionId: params.stripeSubscriptionId,
    currentPeriodEnd: resolvePeriodEnd(params.sub),
  };
}
