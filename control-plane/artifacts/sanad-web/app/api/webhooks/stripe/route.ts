import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { subscriptions, memberships, organizations } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import {
  getStripeSync,
  getUncachableStripeClient,
  getStripeWebhookSecret,
} from "@/lib/stripe/client";
import { nanoid } from "@/lib/id";
import { revokeSessionsForOrg } from "@/lib/auth/session";
import type { Plan } from "@/lib/billing/plans";
import {
  nextSubscriptionState,
  resolvePeriodEnd,
  resolveSeats,
  type StripeSubscriptionShape,
  type SubscriptionPatch,
} from "@/lib/stripe/subscription-state";

export const dynamic = "force-dynamic";

type StripeClient = Awaited<ReturnType<typeof getUncachableStripeClient>>;
type WebhookEvent = { type: string; data: { object: Record<string, unknown> } };

/** Operational failure: Stripe should redeliver, so answer 5xx. */
function retryable(message: string, err: unknown) {
  console.error(`Stripe webhook (retryable): ${message}`, err);
  return NextResponse.json({ error: message }, { status: 500 });
}

/** Permanent failure: redelivering cannot help, so answer 4xx. */
function permanent(message: string, err?: unknown) {
  console.error(`Stripe webhook (permanent): ${message}`, err ?? "");
  return NextResponse.json({ error: message }, { status: 400 });
}

/** Resolve our plan from the Stripe product metadata attached to a price. */
async function getPlanFromPriceId(
  stripe: StripeClient,
  priceId: string,
): Promise<Plan> {
  const price = await stripe.prices.retrieve(priceId, { expand: ["product"] });
  const product = price.product as { metadata?: Record<string, string> };
  const plan = product.metadata?.plan;
  if (plan === "pro" || plan === "team") return plan;
  return "free";
}

/**
 * Find the org a Stripe event belongs to. Metadata is the primary path; the
 * stored Stripe subscription id is the fallback so events still land if
 * metadata was lost (for example a subscription edited in the Stripe dashboard).
 */
async function resolveOrgId(
  metadataOrgId: string | undefined,
  stripeSubscriptionId: string | null,
): Promise<string | null> {
  if (metadataOrgId) return metadataOrgId;
  if (!stripeSubscriptionId) return null;

  const [row] = await db
    .select({ orgId: subscriptions.orgId })
    .from(subscriptions)
    .where(eq(subscriptions.stripeSubscriptionId, stripeSubscriptionId))
    .limit(1);

  return row?.orgId ?? null;
}

/** Write a computed subscription state to the org's row, inserting if needed. */
async function applySubscriptionPatch(params: {
  orgId: string;
  patch: SubscriptionPatch;
  stripeCustomerId?: string | null;
}) {
  const { orgId, patch, stripeCustomerId } = params;

  const updates: Partial<typeof subscriptions.$inferInsert> = {
    plan: patch.plan,
    status: patch.status,
    seats: patch.seats,
    stripeSubscriptionId: patch.stripeSubscriptionId,
    currentPeriodEnd: patch.currentPeriodEnd,
  };
  if (patch.quota) updates.quota = patch.quota;
  // Only overwrite the customer id when the event carries one, so a downgrade
  // keeps the customer on file and the billing portal keeps working.
  if (stripeCustomerId) updates.stripeCustomerId = stripeCustomerId;

  const existing = await db
    .select({ id: subscriptions.id })
    .from(subscriptions)
    .where(eq(subscriptions.orgId, orgId))
    .limit(1);

  if (existing.length > 0) {
    await db
      .update(subscriptions)
      .set(updates)
      .where(eq(subscriptions.orgId, orgId));
    return;
  }

  await db.insert(subscriptions).values({
    id: nanoid(),
    orgId,
    plan: patch.plan,
    status: patch.status,
    seats: patch.seats,
    quota: patch.quota ?? {},
    stripeCustomerId: stripeCustomerId ?? null,
    stripeSubscriptionId: patch.stripeSubscriptionId,
    currentPeriodEnd: patch.currentPeriodEnd,
  });
}

/**
 * Keep organizations.type in lockstep with the subscription plan.
 *
 * Entitlement short-circuits for `type = "personal"` orgs, so an org left as
 * personal after buying the Team plan would never have seats enforced. The
 * plan is the source of truth: an org on the Team plan is a team org, any
 * other plan (pro/free, including the cancellation downgrade) makes it a
 * personal org again so the owner keeps free-tier access instead of being
 * locked out behind a seat check. Idempotent: writes absolute state.
 */
async function syncOrgType(orgId: string, plan: Plan) {
  await db
    .update(organizations)
    .set({ type: plan === "team" ? "team" : "personal" })
    .where(eq(organizations.id, orgId));
}

/**
 * When a Team subscription ends (canceled/deleted → downgraded off "team"),
 * revoke every assigned seat in the org. Entitlement for team members is
 * seat-based, so leaving seats assigned after cancellation would keep minting
 * tokens against a plan that no longer exists. Idempotent: replaying the
 * event writes the same absolute state.
 */
async function revokeSeatsIfTeamEnded(orgId: string, nextPlan: Plan) {
  if (nextPlan === "team") return;

  const [existing] = await db
    .select({ plan: subscriptions.plan })
    .from(subscriptions)
    .where(eq(subscriptions.orgId, orgId))
    .limit(1);

  if (existing?.plan !== "team") return;

  await db
    .update(memberships)
    .set({ seatAssigned: false })
    .where(eq(memberships.orgId, orgId));

  // Seats are gone, so every member's CLI access must end now — revoke all
  // live CLI sessions (which cascades to their runtime tokens).
  await revokeSessionsForOrg(orgId);
}

/**
 * Apply one lifecycle event to our own subscriptions table.
 *
 * Throws on failure — the caller turns that into a 5xx so Stripe redelivers.
 * Every branch writes absolute state rather than deltas, so replaying an event
 * converges on the same row instead of double-applying.
 */
async function applyEvent(stripe: StripeClient, event: WebhookEvent) {
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as {
        metadata?: Record<string, string>;
        subscription?: string;
        customer?: string;
      };
      const stripeSubscriptionId = session.subscription ?? null;
      const orgId = await resolveOrgId(
        session.metadata?.orgId,
        stripeSubscriptionId,
      );
      if (!orgId || !stripeSubscriptionId) return;

      const plan = (session.metadata?.plan ?? "free") as Plan;

      // Re-read the subscription so seats and period end come from Stripe
      // rather than the (thinner) checkout session payload.
      const stripeSub = (await stripe.subscriptions.retrieve(
        stripeSubscriptionId,
      )) as unknown as StripeSubscriptionShape;

      await applySubscriptionPatch({
        orgId,
        stripeCustomerId: session.customer ?? null,
        patch: {
          plan,
          status: "active",
          seats: resolveSeats(stripeSub),
          stripeSubscriptionId,
          currentPeriodEnd: resolvePeriodEnd(stripeSub),
        },
      });
      await syncOrgType(orgId, plan);
      return;
    }

    case "customer.subscription.updated": {
      const stripeSub = event.data.object as unknown as StripeSubscriptionShape & {
        id: string;
        customer?: string;
        metadata?: Record<string, string>;
      };

      const orgId = await resolveOrgId(stripeSub.metadata?.orgId, stripeSub.id);
      if (!orgId) return;

      const priceId = stripeSub.items?.data?.[0]?.price?.id;
      const plan: Plan = priceId
        ? await getPlanFromPriceId(stripe, priceId)
        : "free";

      const patch = nextSubscriptionState({
        deleted: false,
        plan,
        sub: stripeSub,
        stripeSubscriptionId: stripeSub.id,
      });

      // Must run before the patch overwrites the previous plan.
      await revokeSeatsIfTeamEnded(orgId, patch.plan);

      await applySubscriptionPatch({
        orgId,
        stripeCustomerId: stripeSub.customer ?? null,
        patch,
      });
      await syncOrgType(orgId, patch.plan);
      return;
    }

    case "customer.subscription.deleted": {
      const stripeSub = event.data.object as unknown as StripeSubscriptionShape & {
        id: string;
        metadata?: Record<string, string>;
      };

      const orgId = await resolveOrgId(stripeSub.metadata?.orgId, stripeSub.id);
      if (!orgId) return;

      // A canceled Team subscription must release every seat.
      // Must run before the patch overwrites the previous plan.
      await revokeSeatsIfTeamEnded(orgId, "free");

      // Falls back to an ACTIVE free row — see nextSubscriptionState().
      await applySubscriptionPatch({
        orgId,
        patch: nextSubscriptionState({
          deleted: true,
          plan: "free",
          sub: stripeSub,
          stripeSubscriptionId: stripeSub.id,
        }),
      });
      await syncOrgType(orgId, "free");
      return;
    }

    case "invoice.paid": {
      const invoice = event.data.object as { subscription?: string };
      if (!invoice.subscription) return;

      // Payment recovered: lift the org out of past_due.
      await db
        .update(subscriptions)
        .set({ status: "active" })
        .where(eq(subscriptions.stripeSubscriptionId, invoice.subscription));
      return;
    }

    case "invoice.payment_failed": {
      const invoice = event.data.object as { subscription?: string };
      if (!invoice.subscription) return;

      // Stripe keeps retrying; the plan is preserved and restored by
      // invoice.paid. Terminal failure arrives as subscription.deleted,
      // which downgrades to free.
      await db
        .update(subscriptions)
        .set({ status: "past_due" })
        .where(eq(subscriptions.stripeSubscriptionId, invoice.subscription));
      return;
    }
  }
}

export async function POST(req: NextRequest) {
  const payload = await req.text();
  const signature = req.headers.get("stripe-signature");

  // --- Permanent: an unsigned request is not a Stripe delivery. -------------
  if (!signature) {
    return permanent("Missing stripe-signature");
  }

  // --- Retryable: loading credentials hits the connector API over the network.
  let stripe: StripeClient;
  let webhookSecret: string;
  try {
    stripe = await getUncachableStripeClient();
    webhookSecret = await getStripeWebhookSecret();
  } catch (err) {
    return retryable("Stripe credentials unavailable", err);
  }

  // A missing signing secret is a deployment misconfiguration, not a bad
  // request — 5xx so the event is redelivered once it is configured.
  if (!webhookSecret) {
    return retryable(
      "Webhook signing secret is not configured",
      new Error("STRIPE_WEBHOOK_SECRET missing"),
    );
  }

  // --- Permanent: bad signature or malformed body. Pure crypto + JSON parse,
  // no I/O, so a throw here genuinely means the request is invalid. ----------
  let event: WebhookEvent;
  try {
    event = stripe.webhooks.constructEvent(
      payload,
      signature,
      webhookSecret,
    ) as unknown as WebhookEvent;
  } catch (err) {
    return permanent("Invalid signature or payload", err);
  }

  // --- Retryable: our own entitlement state. Applied before the schema sync
  // because this is the data the app actually gates access on. --------------
  try {
    await applyEvent(stripe, event);
  } catch (err) {
    return retryable(`Failed to apply ${event.type}`, err);
  }

  // --- Retryable: mirror the raw Stripe objects into the `stripe` schema. ---
  try {
    const sync = await getStripeSync();
    await sync.processWebhook(Buffer.from(payload), signature);
  } catch (err) {
    return retryable("Stripe schema sync failed", err);
  }

  return NextResponse.json({ received: true });
}
