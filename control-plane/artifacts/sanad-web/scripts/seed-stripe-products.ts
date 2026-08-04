/**
 * Seed Stripe products for Sanad billing plans.
 *
 * Run once in development:
 *   pnpm --filter @workspace/sanad-web exec tsx scripts/seed-stripe-products.ts
 *
 * The script is idempotent — it checks for existing products before creating.
 * After running, copy the printed price IDs to your environment secrets as:
 *   STRIPE_PRO_PRICE_ID
 *   STRIPE_TEAM_PRICE_ID
 */

import { getUncachableStripeClient } from "../lib/stripe/client";

async function seed() {
  const stripe = await getUncachableStripeClient();

  console.log("Seeding Stripe products…\n");

  // ── Pro Plan ──────────────────────────────────────────────────────────────
  const existingPro = await stripe.products.search({
    query: "name:'Sanad Pro' AND active:'true'",
  });

  let proProductId: string;
  let proPriceId: string;

  if (existingPro.data.length > 0) {
    proProductId = existingPro.data[0].id;
    console.log(`✓ Sanad Pro already exists: ${proProductId}`);

    const prices = await stripe.prices.list({
      product: proProductId,
      active: true,
    });
    proPriceId = prices.data[0]?.id ?? "";
    console.log(`  Price ID: ${proPriceId}`);
  } else {
    const proProduct = await stripe.products.create({
      name: "Sanad Pro",
      description: "Unlimited requests, all models, 5 active CLI sessions.",
      metadata: { plan: "pro" },
    });
    proProductId = proProduct.id;

    const proPrice = await stripe.prices.create({
      product: proProductId,
      unit_amount: 1900, // $19.00
      currency: "usd",
      recurring: { interval: "month" },
      metadata: { plan: "pro" },
    });
    proPriceId = proPrice.id;

    console.log(`✓ Created Sanad Pro: ${proProductId}`);
    console.log(`  Price ID: ${proPriceId}  ($19/month)`);
  }

  // ── Team Plan ─────────────────────────────────────────────────────────────
  const existingTeam = await stripe.products.search({
    query: "name:'Sanad Team' AND active:'true'",
  });

  let teamProductId: string;
  let teamPriceId: string;

  if (existingTeam.data.length > 0) {
    teamProductId = existingTeam.data[0].id;
    console.log(`\n✓ Sanad Team already exists: ${teamProductId}`);

    const prices = await stripe.prices.list({
      product: teamProductId,
      active: true,
    });
    teamPriceId = prices.data[0]?.id ?? "";
    console.log(`  Price ID: ${teamPriceId}`);
  } else {
    const teamProduct = await stripe.products.create({
      name: "Sanad Team",
      description:
        "Everything in Pro, org-scoped subscriptions, seat management, enterprise SSO.",
      metadata: { plan: "team" },
    });
    teamProductId = teamProduct.id;

    const teamPrice = await stripe.prices.create({
      product: teamProductId,
      unit_amount: 4900, // $49.00
      currency: "usd",
      recurring: { interval: "month" },
      metadata: { plan: "team" },
    });
    teamPriceId = teamPrice.id;

    console.log(`\n✓ Created Sanad Team: ${teamProductId}`);
    console.log(`  Price ID: ${teamPriceId}  ($49/seat/month)`);
  }

  console.log("\n─────────────────────────────────────────────────────");
  console.log("Add these to your environment secrets:");
  console.log(`  STRIPE_PRO_PRICE_ID=${proPriceId}`);
  console.log(`  STRIPE_TEAM_PRICE_ID=${teamPriceId}`);
  console.log("─────────────────────────────────────────────────────\n");
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
