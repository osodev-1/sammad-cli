/**
 * Usage metering vocabulary shared by the dashboard meter, its alerts and the
 * server-side quota gate.
 *
 * Pure functions only — no database access — so the same computation can run
 * in a server component, in an API route and in tests. See `./quota.ts` for
 * the DB-backed aggregation that feeds this.
 *
 * Thresholds are expressed in terms of allowance REMAINING, since that is the
 * number a user acts on ("I have 8% left"), not the number consumed.
 */

export type UsageLevel = "ok" | "warning" | "critical" | "exceeded";
export type UsageDimension = "requests" | "tokens";

/** Fraction of the allowance still available at each escalation. */
export const USAGE_THRESHOLDS = {
  /** At or below a quarter left, start warning. */
  warning: 0.25,
  /** At or below a tenth left, escalate. */
  critical: 0.1,
} as const;

/** Ordering so two dimensions can be compared and the worse one surfaced. */
const SEVERITY: Record<UsageLevel, number> = {
  ok: 0,
  warning: 1,
  critical: 2,
  exceeded: 3,
};

export interface DimensionStatus {
  used: number;
  limit: number;
  /** Never negative — overage is conveyed by `level`, not a negative balance. */
  remaining: number;
  usedPct: number;
  remainingPct: number;
  level: UsageLevel;
}

/** Status of one metered dimension against its cap. */
export function computeDimension(used: number, limit: number): DimensionStatus {
  const safeLimit = Math.max(limit, 1);
  const safeUsed = Math.max(used, 0);
  const remaining = Math.max(safeLimit - safeUsed, 0);
  const remainingFraction = remaining / safeLimit;

  const level: UsageLevel =
    remaining <= 0
      ? "exceeded"
      : remainingFraction <= USAGE_THRESHOLDS.critical
        ? "critical"
        : remainingFraction <= USAGE_THRESHOLDS.warning
          ? "warning"
          : "ok";

  return {
    used: safeUsed,
    limit: safeLimit,
    remaining,
    /*
     * Held below 100 until the allowance is genuinely gone, and above 0 while
     * any balance survives. Plain rounding let 99.6% display as "100% used"
     * next to a chip insisting tokens remained.
     */
    usedPct:
      remaining <= 0
        ? 100
        : Math.min(99, Math.floor((safeUsed / safeLimit) * 100)),
    remainingPct:
      remaining <= 0 ? 0 : Math.max(1, Math.round(remainingFraction * 100)),
    level,
  };
}

export interface UsageStatus {
  requests: DimensionStatus;
  tokens: DimensionStatus;
  /** Worst of the two dimensions — what the gate and headline chip use. */
  level: UsageLevel;
  /** Whichever dimension is closest to running out. */
  binding: UsageDimension;
  isExceeded: boolean;
}

export function computeUsage(input: {
  requestsUsed: number;
  requestsLimit: number;
  tokensUsed: number;
  tokensLimit: number;
}): UsageStatus {
  const requests = computeDimension(input.requestsUsed, input.requestsLimit);
  const tokens = computeDimension(input.tokensUsed, input.tokensLimit);

  /*
   * Both caps are enforced, so the org's real state is the WORSE of the two.
   * Ties break toward whichever has proportionally less left, so the headline
   * always points at the cap the user will actually hit first.
   */
  const requestsWorse =
    SEVERITY[requests.level] > SEVERITY[tokens.level] ||
    (SEVERITY[requests.level] === SEVERITY[tokens.level] &&
      requests.remainingPct <= tokens.remainingPct);

  const binding: UsageDimension = requestsWorse ? "requests" : "tokens";
  const worst = requestsWorse ? requests : tokens;

  return {
    requests,
    tokens,
    level: worst.level,
    binding,
    isExceeded: requests.remaining <= 0 || tokens.remaining <= 0,
  };
}

/** Short label for the status chip beside the section heading. */
export const USAGE_LEVEL_LABEL: Record<UsageLevel, string> = {
  ok: "Healthy",
  warning: "Running low",
  critical: "Almost out",
  exceeded: "Limit reached",
};

export const DIMENSION_LABEL: Record<UsageDimension, string> = {
  requests: "requests",
  tokens: "tokens",
};

/**
 * Alert copy for the binding dimension. Returns null at "ok" so callers can
 * treat absence of a message as "nothing to notify about".
 */
export function usageAlert(
  status: UsageStatus,
): { title: string; body: string } | null {
  const dim = status.binding;
  const d = status[dim];
  const noun = DIMENSION_LABEL[dim];
  const remaining = d.remaining.toLocaleString();

  switch (status.level) {
    case "exceeded": {
      const which = status[dim].remaining <= 0 ? noun : DIMENSION_LABEL.tokens;
      return {
        title: `You've used your entire monthly ${which} allowance`,
        body: "New CLI runs are blocked until the allowance resets or you upgrade.",
      };
    }
    case "critical":
      return {
        title: `Only ${remaining} ${noun} left`,
        body: `That's ${d.remainingPct}% of this period's allowance. Upgrade now to avoid interrupting your CLI sessions.`,
      };
    case "warning":
      return {
        title: `${remaining} ${noun} remaining`,
        body: `You've used ${d.usedPct}% of this period's ${noun} allowance.`,
      };
    default:
      return null;
  }
}
