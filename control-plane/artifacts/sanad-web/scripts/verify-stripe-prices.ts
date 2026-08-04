/**
 * Verify the configured Stripe price IDs are actually usable for checkout.
 *
 *   pnpm --filter @workspace/sanad-web run stripe:verify
 *
 * Run this after connecting (or reconnecting) the Stripe integration, or after
 * changing STRIPE_PRO_PRICE_ID / STRIPE_TEAM_PRICE_ID.
 *
 * It catches the failure modes that are invisible until a real customer hits
 * them — most importantly a price that belongs to a different Stripe account
 * than the connected key, and a product missing the `plan` metadata the
 * webhook uses to decide what someone actually bought.
 *
 * Exits non-zero if anything would break, so it is safe to use as a gate.
 */

import { getUncachableStripeClient } from "../lib/stripe/client";

type PlanKey = "pro" | "team";

const TARGETS: { plan: PlanKey; envKey: string; id: string | undefined }[] = [
  { plan: "pro", envKey: "STRIPE_PRO_PRICE_ID", id: process.env.STRIPE_PRO_PRICE_ID },
  { plan: "team", envKey: "STRIPE_TEAM_PRICE_ID", id: process.env.STRIPE_TEAM_PRICE_ID },
];

async function verify() {
  const stripe = await getUncachableStripeClient();

  // GET /v1/account (no id) returns the account the key belongs to, but the
  // SDK only declares the connected-account overload that requires an id.
  const account = await (
    stripe.accounts.retrieve as unknown as () => Promise<{ id: string }>
  )();

  /**
   * Stripe embeds the account id in every object id, and test and live mode
   * share one account. So a price id that does not carry this suffix belongs
   * to a *different account*, not merely a different mode — a distinction
   * that is otherwise easy to misdiagnose.
   */
  const accountSuffix = account.id.slice(-10);

  console.log(`Connected Stripe account: ${account.id}\n`);

  const problems: string[] = [];
  const fail = (msg: string) => {
    problems.push(msg);
    console.log(`  ✗ ${msg}`);
  };
  let sawLiveMode = false;

  for (const { plan, envKey, id } of TARGETS) {
    console.log(`${plan}:`);

    if (!id) {
      fail(`${envKey} is not set`);
      continue;
    }
    if (!id.startsWith("price_")) {
      fail(`${envKey} is "${id.split("_")[0]}_…", which is not a price id`);
      continue;
    }

    let price;
    try {
      price = await stripe.prices.retrieve(id, { expand: ["product"] });
    } catch (err) {
      if (!id.includes(accountSuffix)) {
        fail(
          `${envKey} belongs to a different Stripe account than the connected key ` +
            `(expected ids containing "${accountSuffix}"). Reconnect the Stripe ` +
            `integration to the owning account, or use that account's price ids.`
        );
      } else {
        fail(`${envKey} was rejected by Stripe: ${(err as Error).message}`);
      }
      continue;
    }

    const product = price.product as {
      id: string;
      name?: string;
      active?: boolean;
      deleted?: boolean;
      metadata?: Record<string, string>;
    };

    if (price.livemode) sawLiveMode = true;

    console.log(
      `  ${price.id} — ${(price.unit_amount ?? 0) / 100} ${price.currency.toUpperCase()}` +
        `/${price.recurring?.interval ?? "one-off"} — "${product.name ?? "?"}"` +
        ` — ${price.livemode ? "LIVE" : "TEST"}`
    );

    if (!price.active) fail(`${envKey}: price is archived, checkout will reject it`);
    if (price.type !== "recurring") {
      fail(`${envKey}: price is one-off but checkout uses mode:"subscription"`);
    }
    if (product.deleted) fail(`${envKey}: product is deleted`);
    if (product.active === false) fail(`${envKey}: product is archived`);

    // The webhook resolves our plan from product metadata. Without it, checkout
    // succeeds and the customer is charged, but they silently stay on free.
    if (product.metadata?.plan !== plan) {
      fail(
        `${envKey}: product metadata.plan is ${JSON.stringify(product.metadata?.plan)} ` +
          `but must be "${plan}", or paying customers stay on the free plan`
      );
    }
  }

  console.log();

  if (problems.length === 0) {
    console.log("All configured prices are usable.");
    if (!sawLiveMode) {
      console.log(
        "Note: these are TEST-mode prices — real payments require live keys."
      );
    }
    return;
  }

  console.log(`${problems.length} problem(s) found — checkout would fail.`);
  process.exitCode = 1;
}

verify().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
