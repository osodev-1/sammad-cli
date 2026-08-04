import { describe, it, expect } from "vitest";
import {
  mapStripeStatus,
  nextSubscriptionState,
  resolvePeriodEnd,
  resolveSeats,
} from "./subscription-state";

const PERIOD_END = 1_800_000_000; // epoch seconds

describe("resolvePeriodEnd", () => {
  it("prefers the item-level period end (Stripe 2025+ shape)", () => {
    const date = resolvePeriodEnd({
      current_period_end: 1_700_000_000,
      items: { data: [{ current_period_end: PERIOD_END }] },
    });
    expect(date).toEqual(new Date(PERIOD_END * 1000));
  });

  it("falls back to the legacy top-level period end", () => {
    const date = resolvePeriodEnd({ current_period_end: PERIOD_END });
    expect(date).toEqual(new Date(PERIOD_END * 1000));
  });

  it("returns null instead of an Invalid Date when the field is missing", () => {
    expect(resolvePeriodEnd({})).toBeNull();
    expect(resolvePeriodEnd({ items: { data: [] } })).toBeNull();
  });

  it("rejects non-finite and non-positive values", () => {
    for (const bad of [undefined, null, 0, -1, NaN, Infinity]) {
      expect(
        resolvePeriodEnd({ current_period_end: bad as number }),
      ).toBeNull();
    }
  });
});

describe("resolveSeats", () => {
  it("reads the quantity of the first item", () => {
    expect(resolveSeats({ items: { data: [{ quantity: 5 }] } })).toBe(5);
  });

  it("defaults to one seat for missing or invalid quantities", () => {
    expect(resolveSeats({})).toBe(1);
    expect(resolveSeats({ items: { data: [{ quantity: 0 }] } })).toBe(1);
    expect(resolveSeats({ items: { data: [{ quantity: null }] } })).toBe(1);
  });
});

describe("mapStripeStatus", () => {
  it("treats trialing as active so trial users stay entitled", () => {
    expect(mapStripeStatus("trialing")).toBe("active");
    expect(mapStripeStatus("active")).toBe("active");
  });

  it("maps dunning states to past_due", () => {
    expect(mapStripeStatus("past_due")).toBe("past_due");
    expect(mapStripeStatus("unpaid")).toBe("past_due");
  });

  it("treats terminal and unknown states as canceled", () => {
    expect(mapStripeStatus("canceled")).toBe("canceled");
    expect(mapStripeStatus("incomplete_expired")).toBe("canceled");
    expect(mapStripeStatus(undefined)).toBe("canceled");
  });
});

describe("nextSubscriptionState — entitlement outcomes", () => {
  const paidSub = {
    status: "active",
    items: { data: [{ quantity: 3, current_period_end: PERIOD_END }] },
  };

  it("checkout/update on a live subscription stores the paid plan as active", () => {
    const patch = nextSubscriptionState({
      deleted: false,
      plan: "team",
      sub: paidSub,
      stripeSubscriptionId: "sub_123",
    });

    expect(patch).toMatchObject({
      plan: "team",
      status: "active",
      seats: 3,
      stripeSubscriptionId: "sub_123",
    });
    expect(patch.currentPeriodEnd).toEqual(new Date(PERIOD_END * 1000));
  });

  // The regression this module exists to prevent: requireEntitled() matches
  // only `status = "active"`, so a cancelled org written as
  // `plan: "free", status: "canceled"` loses free-tier access entirely.
  it("customer.subscription.deleted falls back to an ACTIVE free row", () => {
    const patch = nextSubscriptionState({
      deleted: true,
      plan: "pro",
      sub: paidSub,
      stripeSubscriptionId: "sub_123",
    });

    expect(patch.plan).toBe("free");
    expect(patch.status).toBe("active"); // still entitled to free tier
    expect(patch.seats).toBe(1);
    expect(patch.quota).toEqual({
      requestsPerMonth: 500,
      tokensPerMonth: 1_000_000,
    });
    expect(patch.stripeSubscriptionId).toBeNull();
    expect(patch.currentPeriodEnd).toBeNull();
  });

  it("customer.subscription.updated to a cancelled status also falls back to free", () => {
    const patch = nextSubscriptionState({
      deleted: false,
      plan: "pro",
      sub: { ...paidSub, status: "canceled" },
      stripeSubscriptionId: "sub_123",
    });

    expect(patch.plan).toBe("free");
    expect(patch.status).toBe("active");
  });

  it("keeps a past_due paid subscription on its plan pending Stripe retries", () => {
    const patch = nextSubscriptionState({
      deleted: false,
      plan: "pro",
      sub: { ...paidSub, status: "past_due" },
      stripeSubscriptionId: "sub_123",
    });

    expect(patch.plan).toBe("pro");
    expect(patch.status).toBe("past_due");
  });

  it("never produces an Invalid Date when Stripe omits the period end", () => {
    const patch = nextSubscriptionState({
      deleted: false,
      plan: "pro",
      sub: { status: "active", items: { data: [{ quantity: 1 }] } },
      stripeSubscriptionId: "sub_123",
    });

    expect(patch.currentPeriodEnd).toBeNull();
  });
});
