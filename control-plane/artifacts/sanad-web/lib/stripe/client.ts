import Stripe from "stripe";
import { StripeSync, runMigrations } from "stripe-replit-sync";

/**
 * Stripe credentials from the environment.
 *
 * These were previously fetched from Replit's connector API at runtime; that
 * coupling is gone now that the control plane runs on Railway. Set
 * `STRIPE_SECRET_KEY` (required) and `STRIPE_WEBHOOK_SECRET` (needed for
 * webhook signature verification) as service variables.
 */
function getStripeCredentials(): { secretKey: string; webhookSecret?: string } {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    throw new Error("STRIPE_SECRET_KEY environment variable is required");
  }
  return {
    secretKey,
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || undefined,
  };
}

/** Returns an authenticated Stripe client. */
export async function getUncachableStripeClient(): Promise<Stripe> {
  const { secretKey } = getStripeCredentials();
  return new Stripe(secretKey);
}

/** Returns the Stripe webhook signing secret for manual event verification. */
export async function getStripeWebhookSecret(): Promise<string> {
  const { webhookSecret } = getStripeCredentials();
  return webhookSecret ?? "";
}

/**
 * Returns a StripeSync instance for webhook processing and data sync.
 * Runs the (idempotent) sync-table migrations first.
 */
export async function getStripeSync(): Promise<StripeSync> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL environment variable is required");
  }

  // Idempotent — safe to call on every request.
  await runMigrations({ databaseUrl });

  const { secretKey, webhookSecret } = getStripeCredentials();
  return new StripeSync({
    poolConfig: { connectionString: databaseUrl },
    stripeSecretKey: secretKey,
    stripeWebhookSecret: webhookSecret ?? "",
  });
}
