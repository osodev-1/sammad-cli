import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

const constructEvent = vi.fn();
const processWebhook = vi.fn();
const subscriptionsRetrieve = vi.fn();
const pricesRetrieve = vi.fn();

const getStripeClientMock = vi.fn();
const getWebhookSecretMock = vi.fn();
const getStripeSyncMock = vi.fn();

type DbBehavior = {
  selectRows: unknown[];
  failOn: null | "select" | "update" | "insert";
};

const dbBehavior: DbBehavior = { selectRows: [], failOn: null };
const recorded: {
  updates: Record<string, unknown>[];
  inserts: Record<string, unknown>[];
} = { updates: [], inserts: [] };

vi.mock("@/lib/stripe/client", () => ({
  getUncachableStripeClient: () => getStripeClientMock(),
  getStripeWebhookSecret: () => getWebhookSecretMock(),
  getStripeSync: () => getStripeSyncMock(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        // Awaitable directly (session lookups) and chainable via .limit(1).
        where: () => {
          const rows = (async () => {
            if (dbBehavior.failOn === "select") throw new Error("db unavailable");
            return dbBehavior.selectRows;
          })();
          return Object.assign(rows, { limit: async () => rows });
        },
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          if (dbBehavior.failOn === "update") throw new Error("db unavailable");
          recorded.updates.push(values);
        },
      }),
    }),
    insert: () => ({
      values: async (values: Record<string, unknown>) => {
        if (dbBehavior.failOn === "insert") throw new Error("db unavailable");
        recorded.inserts.push(values);
      },
    }),
  },
}));

const { POST } = await import("./route");

function request(body: unknown, signature: string | null = "sig_test") {
  return {
    text: async () => JSON.stringify(body),
    headers: {
      get: (key: string) => (key === "stripe-signature" ? signature : null),
    },
  } as unknown as NextRequest;
}

const deletedEvent = {
  type: "customer.subscription.deleted",
  data: { object: { id: "sub_1", metadata: { orgId: "org_1" } } },
};

const checkoutEvent = {
  type: "checkout.session.completed",
  data: {
    object: {
      metadata: { orgId: "org_1", plan: "pro" },
      subscription: "sub_1",
      customer: "cus_1",
    },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  dbBehavior.selectRows = [{ id: "row_1" }];
  dbBehavior.failOn = null;
  recorded.updates = [];
  recorded.inserts = [];

  constructEvent.mockImplementation((payload: string) => JSON.parse(payload));
  getStripeClientMock.mockResolvedValue({
    webhooks: { constructEvent },
    subscriptions: { retrieve: subscriptionsRetrieve },
    prices: { retrieve: pricesRetrieve },
  });
  getWebhookSecretMock.mockResolvedValue("whsec_test");
  getStripeSyncMock.mockResolvedValue({ processWebhook });
  processWebhook.mockResolvedValue(undefined);
  subscriptionsRetrieve.mockResolvedValue({
    items: { data: [{ quantity: 2, current_period_end: 1_800_000_000 }] },
  });

  vi.spyOn(console, "error").mockImplementation(() => {});
});

// 4xx: redelivering the same request can never succeed.
describe("permanent failures answer 4xx (no retry)", () => {
  it("rejects a request with no signature header", async () => {
    expect((await POST(request(deletedEvent, null))).status).toBe(400);
  });

  it("rejects a bad signature", async () => {
    constructEvent.mockImplementation(() => {
      throw new Error("no signatures found matching the expected signature");
    });
    expect((await POST(request(deletedEvent))).status).toBe(400);
  });

  it("rejects a malformed payload", async () => {
    constructEvent.mockImplementation(() => {
      throw new Error("Unexpected token in JSON");
    });
    expect((await POST(request("not-json"))).status).toBe(400);
  });
});

// 5xx: the request was valid, a dependency failed. Stripe must redeliver or
// subscriptions.plan/status silently goes stale forever.
describe("transient failures answer 5xx (retry)", () => {
  it("retries when the connector credential fetch fails", async () => {
    getStripeClientMock.mockRejectedValue(new Error("connector timeout"));
    expect((await POST(request(deletedEvent))).status).toBe(500);
  });

  it("retries when the signing secret is not configured yet", async () => {
    getWebhookSecretMock.mockResolvedValue("");
    expect((await POST(request(deletedEvent))).status).toBe(500);
  });

  it("retries when the database write fails", async () => {
    dbBehavior.failOn = "update";

    const res = await POST(request(deletedEvent));

    expect(res.status).toBe(500);
    expect(recorded.updates).toHaveLength(0);
  });

  it("retries when the Stripe API lookup fails during checkout", async () => {
    subscriptionsRetrieve.mockRejectedValue(new Error("stripe timeout"));
    expect((await POST(request(checkoutEvent))).status).toBe(500);
  });

  it("retries when getStripeSync fails (migrations / connector)", async () => {
    getStripeSyncMock.mockRejectedValue(new Error("migrations failed"));
    expect((await POST(request(deletedEvent))).status).toBe(500);
  });

  it("retries when the schema sync fails", async () => {
    processWebhook.mockRejectedValue(new Error("sync unavailable"));
    expect((await POST(request(deletedEvent))).status).toBe(500);
  });

  // Entitlement state is applied before the schema sync, so a sync outage
  // cannot stop a cancellation from taking effect.
  it("still applies entitlement state when only the schema sync fails", async () => {
    processWebhook.mockRejectedValue(new Error("sync unavailable"));

    await POST(request(deletedEvent));

    expect(recorded.updates[0]).toMatchObject({ plan: "free", status: "active" });
  });
});

describe("successful delivery", () => {
  it("revokes every seat when a Team subscription is deleted", async () => {
    // The org's existing row is on the team plan.
    dbBehavior.selectRows = [{ id: "row_1", plan: "team", orgId: "org_1" }];

    const res = await POST(request(deletedEvent));

    expect(res.status).toBe(200);
    // First write: seats revoked.
    expect(recorded.updates[0]).toEqual({ seatAssigned: false });
    // Next writes: each live CLI session is revoked with its runtime tokens
    // (the mocked session lookup returns one row).
    expect(recorded.updates[1]).toEqual({ revokedAt: expect.any(Date) });
    expect(recorded.updates[2]).toEqual({ revokedAt: expect.any(Date) });
    // Then: downgrade to free.
    expect(recorded.updates[3]).toMatchObject({ plan: "free", status: "active" });
    // Finally: the org stops being a team org.
    expect(recorded.updates[4]).toEqual({ type: "personal" });
  });

  it("marks the org as a team org when a Team checkout completes", async () => {
    const teamCheckout = {
      ...checkoutEvent,
      data: {
        object: { ...checkoutEvent.data.object, metadata: { orgId: "org_1", plan: "team" } },
      },
    };

    const res = await POST(request(teamCheckout));

    expect(res.status).toBe(200);
    expect(recorded.updates.some((u) => u.type === "team")).toBe(true);
  });

  it("reverts the org to personal when the subscription is deleted", async () => {
    await POST(request(deletedEvent));

    expect(recorded.updates.some((u) => u.type === "personal")).toBe(true);
    expect(recorded.updates.some((u) => u.type === "team")).toBe(false);
  });

  it("does not touch seats when a non-team subscription is deleted", async () => {
    dbBehavior.selectRows = [{ id: "row_1", plan: "pro", orgId: "org_1" }];

    await POST(request(deletedEvent));

    expect(
      recorded.updates.some((u) => "seatAssigned" in u)
    ).toBe(false);
  });

  it("acks 200 and downgrades a cancelled org to an ACTIVE free row", async () => {
    const res = await POST(request(deletedEvent));

    expect(res.status).toBe(200);
    expect(recorded.updates[0]).toMatchObject({
      plan: "free",
      status: "active", // stays entitled to the free tier
      seats: 1,
      stripeSubscriptionId: null,
      currentPeriodEnd: null,
    });
  });

  it("converges on the same state when a redelivered event is replayed", async () => {
    expect((await POST(request(checkoutEvent))).status).toBe(200);
    expect((await POST(request(checkoutEvent))).status).toBe(200);

    // Handlers write absolute state, so a replay is a no-op, not a double-apply.
    // Each delivery writes the subscription patch then the org type.
    expect(recorded.updates).toHaveLength(4);
    expect(recorded.updates[0]).toEqual(recorded.updates[2]);
    expect(recorded.updates[1]).toEqual(recorded.updates[3]);
    expect(recorded.updates[0]).toMatchObject({
      plan: "pro",
      status: "active",
      seats: 2,
    });
  });
});
