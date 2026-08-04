/**
 * Plan vocabulary shared by org provisioning, Stripe billing and the
 * entitlement gate.
 */
export type Plan = "free" | "pro" | "team";
export type SubStatus = "active" | "past_due" | "canceled";

/**
 * A monthly allowance. Deliberately a `type` rather than an `interface` so it
 * keeps an implicit index signature and stays assignable to the
 * `Record<string, number>` that the Stripe patch and the jsonb column expect.
 */
export type PlanQuota = {
  requestsPerMonth: number;
  tokensPerMonth: number;
};

/**
 * Monthly allowances per plan.
 *
 * BOTH dimensions are metered and enforced — whichever is exhausted first
 * gates the org. Requests bound how often the CLI may call out; tokens bound
 * how much work those calls do. A cheap-but-chatty workload and a single
 * enormous prompt are different costs, and one cap alone misses one of them.
 *
 * NOTE: these figures are placeholders chosen to be plausible, not a priced
 * business decision — confirm them before launch.
 */
export const PLAN_QUOTA: Record<Plan, PlanQuota> = {
  free: { requestsPerMonth: 500, tokensPerMonth: 1_000_000 },
  pro: { requestsPerMonth: 25_000, tokensPerMonth: 50_000_000 },
  team: { requestsPerMonth: 100_000, tokensPerMonth: 150_000_000 },
};

/** Allowance granted to a free-tier org. */
export const FREE_QUOTA: PlanQuota = { ...PLAN_QUOTA.free };

/** Allowance for a plan, falling back to the free tier for unknown values. */
export function quotaForPlan(plan: string): PlanQuota {
  return PLAN_QUOTA[plan as Plan] ?? PLAN_QUOTA.free;
}

/**
 * Effective allowance for a subscription row.
 *
 * The `quota` jsonb column is an OVERRIDE (e.g. a negotiated enterprise deal),
 * so a stored value wins — but only if it is a usable positive number. Garbage
 * or partial overrides fall back per-field to the plan default rather than
 * collapsing the cap to zero and locking the org out.
 */
export function resolveQuota(plan: string, stored: unknown): PlanQuota {
  const base = quotaForPlan(plan);
  const o = (stored ?? {}) as Partial<Record<keyof PlanQuota, unknown>>;
  const pick = (v: unknown, fallback: number) =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback;

  return {
    requestsPerMonth: pick(o.requestsPerMonth, base.requestsPerMonth),
    tokensPerMonth: pick(o.tokensPerMonth, base.tokensPerMonth),
  };
}

/**
 * Canonical state of a free-tier subscription row.
 *
 * `requireEntitled()` only matches rows with `status = "active"`, so the free
 * tier is represented as an ACTIVE row on the "free" plan — never as a
 * cancelled row. Every downgrade path (subscription cancelled or deleted in
 * Stripe) must land back on exactly this state; writing
 * `plan: "free", status: "canceled"` would leave the org with no entitlement
 * at all instead of falling back to free.
 *
 * Returns a fresh object per call so callers cannot mutate shared state.
 */
export function freePlanState() {
  return {
    plan: "free" as const,
    status: "active" as const,
    seats: 1,
    quota: { ...FREE_QUOTA },
  };
}
