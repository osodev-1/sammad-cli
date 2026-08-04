import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "@/lib/db";
import { subscriptions, users } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
import { getUncachableStripeClient } from "@/lib/stripe/client";
import { nanoid } from "@/lib/id";

const PLAN_PRICE_IDS: Record<string, string | undefined> = {
  pro: process.env.STRIPE_PRO_PRICE_ID,
  team: process.env.STRIPE_TEAM_PRICE_ID,
};

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const plan = body.plan as string;

  if (!["pro", "team"].includes(plan)) {
    return NextResponse.json({ error: "Invalid plan" }, { status: 400 });
  }

  const priceId = PLAN_PRICE_IDS[plan];
  if (!priceId) {
    return NextResponse.json(
      { error: `Price ID not configured for plan: ${plan}` },
      { status: 500 }
    );
  }

  // Personal org for this user
  const orgId = `personal_${userId}`;

  // Fetch user email for customer creation
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  // Fetch or create subscription record
  let [sub] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.orgId, orgId))
    .limit(1);

  const stripe = await getUncachableStripeClient();

  // Find or create Stripe customer
  let customerId = sub?.stripeCustomerId;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: user.email,
      metadata: { orgId, userId },
    });
    customerId = customer.id;

    // Persist customer ID now so we can associate the webhook event
    if (sub) {
      await db
        .update(subscriptions)
        .set({ stripeCustomerId: customerId })
        .where(eq(subscriptions.orgId, orgId));
    } else {
      await db.insert(subscriptions).values({
        id: nanoid(),
        orgId,
        plan: "free",
        status: "active",
        stripeCustomerId: customerId,
        seats: 1,
        quota: {},
      });
    }
  }

  const appUrl = process.env.APP_URL ?? "http://localhost:3000";

  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    payment_method_types: ["card"],
    line_items: [{ price: priceId, quantity: 1 }],
    mode: "subscription",
    success_url: `${appUrl}/dashboard?billing=success`,
    cancel_url: `${appUrl}/pricing`,
    metadata: { orgId, plan },
    subscription_data: {
      metadata: { orgId, plan },
    },
  });

  return NextResponse.json({ url: session.url });
}
