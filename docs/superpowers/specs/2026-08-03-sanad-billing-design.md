# sanad — Billing & Subscriptions (Design Spec)

**Status:** DRAFT for review · **Spec 2 of 4** · 2026-08-03
**Depends on:** Spec #1 (auth flow) — reuses the `subscriptions`/`organizations`/`memberships`
tables and the "org-scoped entitlement" model.
**Stack:** Next.js/Vercel + Stripe + Drizzle/Neon (as #1).

> **Decisions to confirm (I picked defaults — correct any):**
> 1. **Plan tiers & prices** (default below): Free $0 · Pro $20/mo · Team $30/seat/mo ·
>    Enterprise custom. ← your call on names + numbers.
> 2. **Free-tier quota** (default): 200 agent requests / month per personal org.
> 3. **Metering vs. seats:** Pro/Team priced per *seat* (flat for Pro = 1 seat); usage above
>    quota is *blocked* (429), not billed as overage. ← confirm you don't want usage-based
>    (metered) billing at launch.
> 4. **Enterprise:** manual (sales-set) subscription rows, not self-serve Checkout.

## 1. Purpose

Turn the "is this org entitled?" interface from Spec #1 into real, Stripe-backed
subscriptions: let self-serve users upgrade, let team admins buy seats, and keep each org's
`subscriptions` row in sync with Stripe so the mint-time entitlement check is always correct.

## 2. Plans (default)

| Plan | Price | Seats | Monthly quota | Identity |
|---|---|---|---|---|
| Free | $0 | 1 (personal org) | 200 requests | self-serve |
| Pro | $20/mo | 1 | 3,000 requests | self-serve |
| Team | $30/seat/mo | N | 3,000 / seat, pooled | self-serve or SSO |
| Enterprise | custom | N | custom | SSO, sales-onboarded |

`quota` is stored as jsonb on `subscriptions` (e.g. `{ "requestsPerMonth": 3000 }`). Quota is
*enforced* by the gateway (Spec #3); this spec only *sets* it from the plan.

## 3. Flows

- **Upgrade (self-serve):** `/pricing` → **Stripe Checkout** (hosted) → on success, webhook
  writes the org's `subscriptions` row (`plan`, `status=active`, `seats`,
  `stripeCustomerId`, `stripeSubscriptionId`, `currentPeriodEnd`). The next runtime-token
  mint sees the new plan immediately.
- **Manage:** `/dashboard` → **Stripe Customer Portal** (hosted) for plan changes, payment
  method, cancellation. Portal changes arrive as webhooks.
- **Seats (Team):** admin sets seat count in `/dashboard` → updates the Stripe subscription
  quantity; admin assigns seats to members (`memberships.seatAssigned`) up to
  `subscriptions.seats`. A member with no seat fails the Spec #1 mint check (`403 no_seat`).
- **Enterprise:** SSO org is JIT-created (Spec #1) with no plan → blocked until an admin runs
  self-serve Team Checkout, or sales manually inserts an `enterprise` subscription row.

## 4. Stripe integration

- **Products/prices** mirror the plan table (create in Stripe; store price IDs in config).
- **Checkout Session** created server-side (`/api/billing/checkout`, Clerk-auth) with the
  org id in `client_reference_id`/metadata so the webhook can map back to the org.
- **Customer Portal** session created server-side (`/api/billing/portal`).
- **Webhooks** (`/api/webhooks/stripe`, signature-verified): handle
  `checkout.session.completed`, `customer.subscription.updated`,
  `customer.subscription.deleted`, `invoice.payment_failed` → upsert the org's
  `subscriptions` row. **Idempotent** via a `stripe_events` table (dedupe by event id).
- **Status mapping:** Stripe `active`/`trialing` → `active`; `past_due`/`unpaid` →
  `past_due` (grace: still entitled until `currentPeriodEnd`, then blocked); `canceled` →
  `canceled` (drop to free personal-org behavior or block, per plan).

## 5. Data model (delta over #1)

- `subscriptions` — already exists; this spec populates `plan`, `status`, `seats`, `quota`,
  `stripeCustomerId`, `stripeSubscriptionId`, `currentPeriodEnd`.
- `stripe_events` — `id` (Stripe event id, PK, for idempotency), `type`, `processedAt`.

## 6. UI
- `/pricing` — the plan table + "Subscribe" (Checkout) / "Current plan".
- `/dashboard` billing panel — current plan, "Manage billing" (Portal), seat controls
  (Team), and the usage widget from #1/#3.

## 7. Security & correctness
- Never trust the client for entitlement — the **webhook** is the only writer of plan/status.
- Verify Stripe webhook signatures; dedupe by event id; make handlers idempotent + retry-safe.
- The org id ↔ Stripe customer mapping is server-authored (Checkout metadata), never
  user-supplied.

## 8. Testing
- Stripe **test mode** + the Stripe CLI to replay webhook fixtures.
- Unit: status mapping, idempotent event handling, seat-count → entitlement.
- Integration: Checkout success → webhook → `subscriptions` row → Spec #1 mint now passes.

## 9. Open questions
- Annual pricing / discounts? Trials? (Spec #1's flow has no trial — freemium instead.)
- Tax/VAT handling (Stripe Tax)?
- Dunning/grace-period length on `past_due`.
