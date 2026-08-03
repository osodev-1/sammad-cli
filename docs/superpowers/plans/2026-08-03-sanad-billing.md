# sanad Billing & Subscriptions — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use `- [ ]` checkboxes.
>
> **Where this runs:** the **same Next.js/Vercel repo as plan #1** (auth flow). Implements **Spec #2** — `2026-08-03-sanad-billing-design.md`. Do plan #1 first (it creates the `subscriptions`/`organizations` tables + the entitlement check this plan feeds).

**Goal:** Turn the "is this org entitled?" interface from plan #1 into real Stripe-backed subscriptions — self-serve upgrade, team seats, and a webhook that keeps each org's `subscriptions` row authoritative.

**Architecture:** Stripe Checkout + Customer Portal (hosted) for all payment UI; a signature-verified, idempotent webhook is the **only writer** of plan/status onto the `subscriptions` table. The mint-time entitlement check (plan #1) reads that table unchanged.

**Tech Stack:** `stripe` Node SDK · Next.js route handlers · Drizzle/Neon · Clerk (org context) · Vitest + Stripe CLI (webhook fixtures).

## Global Constraints
- The **webhook is the sole writer** of `plan`, `status`, `seats`, `stripeCustomerId`,
  `stripeSubscriptionId`, `currentPeriodEnd`. Never trust the client for entitlement.
- **Idempotent** webhooks: dedupe by Stripe event id in a `stripe_events` table; handlers
  must be safe to replay.
- **Plans** (locked): Free $0 (1 seat, 200 req/mo) · Pro $20/mo (1 seat, 3000 req/mo) ·
  Team $30/seat/mo (N seats, 3000/seat) · Enterprise custom. `quota` stored as jsonb
  `{ "requestsPerMonth": <n> }`.
- Org ↔ Stripe customer mapping is **server-authored** (Checkout `client_reference_id` +
  metadata `orgId`), never user-supplied.
- Verify webhook signatures with `STRIPE_WEBHOOK_SECRET`; never log full events.

## File Structure
```
lib/billing/stripe.ts        # Stripe client + price-id map + plan config
lib/billing/sync.ts          # event -> subscriptions upsert (the mapping logic)
lib/db/schema.ts             # + stripe_events table (extend plan #1 schema)
app/api/billing/checkout/route.ts
app/api/billing/portal/route.ts
app/api/webhooks/stripe/route.ts
app/api/billing/seats/route.ts
app/pricing/page.tsx         # plan table + Subscribe
app/dashboard/(billing panel) # current plan, Manage billing, seat controls
tests/unit/billing-sync.test.ts  tests/contract/webhook.test.ts
```

---

### Task 1: Stripe config + `stripe_events` table

**Files:** Create `lib/billing/stripe.ts`; Modify `lib/db/schema.ts`; Test `tests/unit/plan-config.test.ts`

**Interfaces:** Produces `stripe` (SDK client), `PLANS` (`{ key, priceId, quota, seats }[]`), `planForPriceId(id): PlanKey | null`, and the `stripeEvents` table (`id` PK, `type`, `processedAt`).

- [ ] **Step 1: Add the table + config.** In `schema.ts` add `stripeEvents` (`id: text PK`, `type: text`, `processedAt: timestamp`). In `stripe.ts` init `new Stripe(process.env.STRIPE_SECRET_KEY!)` and a `PLANS` array whose `priceId`s come from env (`STRIPE_PRICE_PRO`, `STRIPE_PRICE_TEAM`).
- [ ] **Step 2: Failing test** — `planForPriceId(process.env.STRIPE_PRICE_PRO)` returns `"pro"`; unknown id returns `null`.
- [ ] **Step 3: Run → fail. Step 4: Implement `planForPriceId`.** Run → pass.
- [ ] **Step 5:** `npx drizzle-kit generate && migrate`. Commit: `feat(billing): stripe config + stripe_events table`.

### Task 2: Checkout + Customer Portal endpoints

**Files:** Create `app/api/billing/checkout/route.ts`, `app/api/billing/portal/route.ts`; Test `tests/contract/checkout.test.ts`

**Interfaces:** Consumes Clerk org context. Produces `POST /api/billing/checkout {plan} -> {url}` and `POST /api/billing/portal -> {url}`.

- [ ] **Step 1: Failing test** — POST `/api/billing/checkout` with `{plan:"pro"}` for a signed-in org returns `{ url }` pointing at Stripe; unauthenticated → `401`.
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement checkout.** Resolve the Clerk org; get-or-create its Stripe customer (store `stripeCustomerId` on the subscription row); create a Checkout Session:

```ts
const session = await stripe.checkout.sessions.create({
  mode: "subscription",
  customer: customerId,
  line_items: [{ price: priceId, quantity: seats }],
  client_reference_id: orgId,
  metadata: { orgId },
  success_url: `${process.env.APP_URL}/dashboard?billing=success`,
  cancel_url: `${process.env.APP_URL}/pricing`,
});
return ok({ url: session.url });
```

- [ ] **Step 4: Implement portal** (`stripe.billingPortal.sessions.create({ customer, return_url })`).
- [ ] **Step 5: Run → pass. Commit:** `feat(billing): checkout + customer portal endpoints`.

### Task 3: Webhook — idempotent subscription sync

**Files:** Create `lib/billing/sync.ts`, `app/api/webhooks/stripe/route.ts`; Test `tests/unit/billing-sync.test.ts`, `tests/contract/webhook.test.ts`

**Interfaces:** Produces `syncFromEvent(event: Stripe.Event): Promise<void>` — upserts the org's `subscriptions` row; idempotent via `stripe_events`.

- [ ] **Step 1: Failing unit test** — feed a fake `customer.subscription.updated` event (status `active`, price = Pro, `metadata.orgId="o1"`) to `syncFromEvent`; assert the `o1` subscription row becomes `plan="pro", status="active", currentPeriodEnd=<set>`. Feed the **same event id twice** → the row is written once (idempotent).
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement `syncFromEvent`:**

```ts
export async function syncFromEvent(event: Stripe.Event) {
  const seen = await db.select().from(stripeEvents).where(eq(stripeEvents.id, event.id));
  if (seen.length) return;                         // idempotent replay guard
  const sub = event.data.object as Stripe.Subscription; // for subscription.* events
  const orgId = sub.metadata.orgId;
  const plan = planForPriceId(sub.items.data[0]?.price.id) ?? "free";
  const status = mapStatus(sub.status);            // active|trialing->active; past_due->past_due; canceled->canceled
  await upsertSubscription({ orgId, plan, status, seats: sub.items.data[0]?.quantity ?? 1,
    stripeSubscriptionId: sub.id, stripeCustomerId: String(sub.customer),
    currentPeriodEnd: new Date(sub.current_period_end * 1000), quota: quotaForPlan(plan) });
  await db.insert(stripeEvents).values({ id: event.id, type: event.type, processedAt: new Date() });
}
```

Handle event types: `checkout.session.completed` (first activation → read the subscription), `customer.subscription.updated`, `customer.subscription.deleted` (→ `canceled`), `invoice.payment_failed` (→ `past_due`).

- [ ] **Step 4: Route handler** — verify the signature with `stripe.webhooks.constructEvent(rawBody, sig, secret)` (use the raw body; disable body parsing), call `syncFromEvent`, return `200`. Bad signature → `400`.
- [ ] **Step 5: Contract test** with the **Stripe CLI** (`stripe trigger customer.subscription.updated`) against a local run; assert the row syncs. Commit: `feat(billing): idempotent stripe webhook + subscription sync`.

### Task 4: Seats + entitlement wiring

**Files:** Create `app/api/billing/seats/route.ts`; (reuses plan #1 `requireEntitled`) ; Test `tests/unit/seats.test.ts`

- [ ] **Step 1: Failing test** — assigning a seat to a member of a Team org sets `memberships.seatAssigned=true`; assigning beyond `subscriptions.seats` → error; a member without a seat fails `requireEntitled` with `no_seat`.
- [ ] **Step 2–4:** Implement `POST /api/billing/seats {userId, assigned}` (admin-only, capped at `subscriptions.seats`; when raising the count, `stripe.subscriptions.update` the quantity). Run → pass.
- [ ] **Step 5: Commit:** `feat(billing): seat assignment + entitlement`.

### Task 5: Pricing page + dashboard billing panel

**Files:** Create/modify `app/pricing/page.tsx`, `app/dashboard/page.tsx`

- [ ] **Step 1:** `/pricing` — render `PLANS`; each has "Subscribe" (POST `/api/billing/checkout` → redirect to `url`) or "Current plan".
- [ ] **Step 2:** Dashboard billing panel — current plan + `currentPeriodEnd`, "Manage billing" (→ portal `url`), and Team seat controls. Place it beside the plan-#1 usage widget.
- [ ] **Step 3: Commit:** `feat(billing): pricing page + dashboard billing panel`.

## Self-Review
- **Spec coverage:** §2 plans → Task 1; §3 flows → 2,4,5; §4 Stripe/webhooks → 2,3; §5 data
  (`stripe_events`) → 1; §6 UI → 5; §7 security (sole-writer, idempotency, sig verify) → 3.
- **Placeholders:** `mapStatus`, `quotaForPlan`, `upsertSubscription` are named + specified in
  Task 3; prices come from env (owner sets real Stripe prices). No vague steps.
- **Type consistency:** `PLANS`, `planForPriceId`, `syncFromEvent`, `requireEntitled` (from
  plan #1) used consistently.
