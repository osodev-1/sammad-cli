# sanad Auth & Entitlement Flow — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Where this runs:** a NEW Next.js project (built on Replit, deployed to Vercel) — **not** the sanad CLI repo. Paths and `git` commands below are relative to that new project. This plan implements **Spec #1** — see `2026-08-03-sanad-auth-flow-design.md`.

**Goal:** Build the sanadcode.com control plane that authenticates users (hybrid: self-serve + enterprise SSO via Clerk), gates them by subscription, and issues the tokens the frozen `sanad` CLI needs to log in and run.

**Architecture:** A single Next.js (App Router) app on Vercel is the control plane. Clerk owns browser identity/sessions; our Postgres owns the sanad domain (device requests, CLI session tokens, subscriptions, runtime tokens, usage). The CLI talks to `/api/v1/*` route handlers using an opaque **CLI session token** (bearer); those endpoints must match the frozen contract byte-for-byte. The LLM gateway is a separate service (out of scope) and only consumes the **runtime token** we mint.

**Tech Stack:** Next.js 15 (App Router, TypeScript) · Clerk (`@clerk/nextjs`) · Drizzle ORM + Neon serverless Postgres · Zod · Vitest (unit/contract) · Playwright (E2E).

## Global Constraints

*(Every task implicitly includes these. Copied from the spec.)*

- **Frozen CLI contract.** Endpoints, methods, and JSON shapes in Task 4–7 are non-negotiable — the CLI is already shipped. Do not rename fields.
- **Response envelope, always camelCase:** success = `2xx` `{ "data": <payload>, "meta": { "requestId": "<uuid>" } }`; error = `{ "error": { "code", "message", "requestId", "retryable": <bool> } }`. Timestamps ISO-8601 UTC.
- **Auth header:** authenticated endpoints require `Authorization: Bearer <cliSessionToken>` (NOT a Clerk cookie — the CLI is not a browser).
- **Base routing:** API under `/api/v1/...` on the apex domain (`https://sanadcode.com`), no subdomain.
- **Mint response** must return `modelSettings: {name,maxContextSize,capabilities}[]` + `defaultModelAlias`. **No** `allowedModelAliases` field.
- **Alias → Foundry deployment** (gateway resolves; documented in `lib/models/catalog.ts`): `gpt-5.3-codex`→`gpt-5.3-codex`, `kimi-k2.7-code`→`FW-Kimi-K2.7-Code` (**default**), `deepseek-v4-pro`→`DeepSeek-V4-Pro`, `codestral`→`Codestral-2501`, `mistral-small`→`mistral-small-2503`.
- **Entitlement:** subscriptions are **org-scoped**; every self-serve user gets a **personal org of one** on the `free` plan. Active-plan/seat is checked **at mint**; usage quota is enforced by the gateway (out of scope).
- **Security:** all tokens are high-entropy random secrets **stored as SHA-256 hashes**, never logged; `deviceAuthId`/`userCode` single-use + rate-limited; HTTPS only.

## File Structure

```
app/
  layout.tsx  page.tsx  pricing/page.tsx        # marketing (thin)
  device/page.tsx                               # CLI approval card (Clerk-protected)
  dashboard/page.tsx                            # usage widget + device list (Clerk-protected)
  api/v1/
    auth/device/start/route.ts   auth/device/poll/route.ts
    auth/me/route.ts             auth/logout/route.ts
    runtime-tokens/route.ts      runtime-tokens/renew/route.ts   runtime-tokens/revoke/route.ts
    device/approve/route.ts                     # internal: /device page POSTs here (Clerk-auth)
  api/webhooks/clerk/route.ts                   # user.created -> provision personal org
lib/
  db/schema.ts  db/index.ts                     # Drizzle schema + Neon client
  http/envelope.ts                              # ok()/err()
  auth/tokens.ts                                # newToken()/hashToken()
  auth/session.ts                               # mintSession()/verifyBearer()
  auth/device.ts                                # start/poll/approve state machine
  auth/entitlement.ts                           # requireEntitled()
  tokens/runtime.ts                             # mintRuntime/renew/revoke
  models/catalog.ts                             # MODEL_CATALOG, DEFAULT_MODEL_ALIAS, ALIAS_TO_DEPLOYMENT
  clerk/provisioning.ts                         # provisionPersonalOrg()
middleware.ts                                   # Clerk middleware
drizzle/                                         # generated migrations
tests/unit/  tests/contract/  tests/e2e/
```

---

### Task 1: Project scaffold, envelope, and health check

**Files:**
- Create: `package.json`, `next.config.ts`, `tsconfig.json`, `vitest.config.ts`, `.env.example`
- Create: `lib/http/envelope.ts`, `app/api/health/route.ts`
- Test: `tests/contract/envelope.test.ts`

**Interfaces:**
- Produces: `ok<T>(data: T, status?=200): Response`; `err(status: number, code: string, message: string, retryable?=false): Response` — the ONLY way any route returns JSON.

- [ ] **Step 1: Scaffold.** `npx create-next-app@latest . --ts --app --eslint --no-tailwind --no-src-dir`. Add deps: `npm i @clerk/nextjs drizzle-orm @neondatabase/serverless zod` and dev: `npm i -D drizzle-kit vitest @vitest/coverage-v8`. Add `"test": "vitest run"` to scripts.

- [ ] **Step 2: Write the failing test** — `tests/contract/envelope.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { ok, err } from "@/lib/http/envelope";

describe("envelope", () => {
  it("wraps success in {data, meta.requestId}", async () => {
    const body = await ok({ hello: "world" }).json();
    expect(body.data).toEqual({ hello: "world" });
    expect(typeof body.meta.requestId).toBe("string");
  });
  it("wraps errors in {error:{code,message,requestId,retryable}}", async () => {
    const res = err(403, "tenant_not_allowed", "nope");
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("tenant_not_allowed");
    expect(body.error.retryable).toBe(false);
  });
});
```

- [ ] **Step 3: Run it, watch it fail.** `npm test` → FAIL (`@/lib/http/envelope` missing).

- [ ] **Step 4: Implement** `lib/http/envelope.ts`:

```ts
import { NextResponse } from "next/server";
const rid = () => crypto.randomUUID();
export const ok = <T>(data: T, status = 200) =>
  NextResponse.json({ data, meta: { requestId: rid() } }, { status });
export const err = (status: number, code: string, message: string, retryable = false) =>
  NextResponse.json({ error: { code, message, requestId: rid(), retryable } }, { status });
```

Then `app/api/health/route.ts`: `export const GET = () => ok({ status: "ok" });`

- [ ] **Step 5: Run tests (pass), then commit.** `npm test` → PASS. `git add -A && git commit -m "chore: scaffold + response envelope"`.

---

### Task 2: Database schema + migrations

**Files:**
- Create: `lib/db/schema.ts`, `lib/db/index.ts`, `drizzle.config.ts`
- Test: `tests/unit/schema.test.ts`

**Interfaces:**
- Produces tables: `organizations, users, memberships, subscriptions, deviceAuthRequests, cliSessions, runtimeTokens, usageEvents` and `db` (Drizzle client).

- [ ] **Step 1: Write** `lib/db/schema.ts` (Drizzle, Postgres). Columns per spec §6.4:

```ts
import { pgTable, text, timestamp, integer, boolean, jsonb, pgEnum } from "drizzle-orm/pg-core";

export const planEnum = pgEnum("plan", ["free", "pro", "team", "enterprise"]);
export const subStatus = pgEnum("sub_status", ["active", "past_due", "canceled"]);
export const deviceStatus = pgEnum("device_status", ["pending", "complete", "denied", "expired"]);

export const organizations = pgTable("organizations", {
  id: text("id").primaryKey(),            // Clerk org id
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  type: text("type").notNull(),           // "personal" | "team"
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
export const users = pgTable("users", {
  id: text("id").primaryKey(),            // Clerk user id
  email: text("email").notNull(),
  displayName: text("display_name"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
export const memberships = pgTable("memberships", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id),
  userId: text("user_id").notNull().references(() => users.id),
  role: text("role").notNull(),
  seatAssigned: boolean("seat_assigned").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
export const subscriptions = pgTable("subscriptions", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id),
  plan: planEnum("plan").notNull().default("free"),
  status: subStatus("status").notNull().default("active"),
  stripeCustomerId: text("stripe_customer_id"),
  stripeSubscriptionId: text("stripe_subscription_id"),
  seats: integer("seats").notNull().default(1),
  quota: jsonb("quota").notNull().default({}),
  currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
});
export const deviceAuthRequests = pgTable("device_auth_requests", {
  id: text("id").primaryKey(),
  deviceAuthIdHash: text("device_auth_id_hash").notNull(),  // hash of the CLI poll credential
  userCode: text("user_code").notNull(),
  status: deviceStatus("status").notNull().default("pending"),
  approvedUserId: text("approved_user_id"),
  approvedOrgId: text("approved_org_id"),
  pollIntervalSeconds: integer("poll_interval_seconds").notNull().default(2),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
export const cliSessions = pgTable("cli_sessions", {
  id: text("id").primaryKey(),
  tokenHash: text("token_hash").notNull(),
  userId: text("user_id").notNull().references(() => users.id),
  orgId: text("org_id").notNull().references(() => organizations.id),
  deviceLabel: text("device_label"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});
export const runtimeTokens = pgTable("runtime_tokens", {
  id: text("id").primaryKey(),            // = tokenId
  familyId: text("family_id").notNull(),
  cliSessionId: text("cli_session_id").notNull().references(() => cliSessions.id),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  absoluteExpiresAt: timestamp("absolute_expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
export const usageEvents = pgTable("usage_events", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull(),
  userId: text("user_id").notNull(),
  cliSessionId: text("cli_session_id"),
  modelAlias: text("model_alias").notNull(),
  tokensIn: integer("tokens_in").notNull().default(0),
  tokensOut: integer("tokens_out").notNull().default(0),
  cost: integer("cost").notNull().default(0),  // micro-cents
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
```

- [ ] **Step 2: Client** `lib/db/index.ts`:

```ts
import { drizzle } from "drizzle-orm/neon-http";
import { neon } from "@neondatabase/serverless";
export const db = drizzle(neon(process.env.DATABASE_URL!));
```

`drizzle.config.ts` points at `lib/db/schema.ts` + `DATABASE_URL`.

- [ ] **Step 3: Generate + apply migration.** `npx drizzle-kit generate && npx drizzle-kit migrate`. Verify a `tests/unit/schema.test.ts` that imports every table and asserts `Object.keys(table).length > 0` passes.

- [ ] **Step 4: Commit.** `git add -A && git commit -m "feat(db): drizzle schema + migrations"`.

---

### Task 3: Clerk auth + personal-org provisioning

**Files:**
- Create: `middleware.ts`, `app/layout.tsx` (ClerkProvider), `lib/clerk/provisioning.ts`, `app/api/webhooks/clerk/route.ts`
- Test: `tests/unit/provisioning.test.ts`

**Interfaces:**
- Produces: `provisionPersonalOrg(user: {id,email,displayName?}): Promise<{orgId:string}>` — idempotently creates a `users` row, a personal `organizations` row, a `memberships` row (role `owner`, seat assigned), and a `free` `subscriptions` row.

- [ ] **Step 1: Clerk middleware + provider.** Add `@clerk/nextjs` `clerkMiddleware()` in `middleware.ts`; wrap `app/layout.tsx` in `<ClerkProvider>`. Configure Clerk env keys in `.env.example`. Enable Email, Google, GitHub, and one SAML/enterprise connection in the Clerk dashboard (Entra = one SSO connection).

- [ ] **Step 2: Write the failing test** — `tests/unit/provisioning.test.ts`: calling `provisionPersonalOrg({id:"u1",email:"a@b.co"})` twice creates exactly one org + one free subscription for `u1` (idempotent by userId).

- [ ] **Step 3: Run it** → FAIL.

- [ ] **Step 4: Implement** `lib/clerk/provisioning.ts` — upsert user; if the user has no personal org, insert `organizations(type:"personal")`, `memberships(role:"owner",seatAssigned:true)`, `subscriptions(plan:"free",status:"active",seats:1)`. Use a deterministic personal-org id (e.g. `personal_<userId>`) so it's idempotent.

- [ ] **Step 5: Webhook** `app/api/webhooks/clerk/route.ts` — verify the Clerk `user.created` webhook signature, then call `provisionPersonalOrg`. Return 200.

- [ ] **Step 6: Run tests (pass) + commit.** `git commit -m "feat(auth): clerk + personal-org provisioning"`.

---

### Task 4: Device flow — `start` + `poll`

**Files:**
- Create: `lib/auth/tokens.ts`, `lib/auth/device.ts`, `app/api/v1/auth/device/start/route.ts`, `app/api/v1/auth/device/poll/route.ts`
- Test: `tests/contract/device.test.ts`

**Interfaces:**
- Produces: `newToken(prefix)`, `hashToken(t)`; `startDevice(): Promise<{deviceAuthId,userCode,verificationUri,verificationUriComplete,expiresAt,pollIntervalSeconds}>`; `pollDevice(deviceAuthId): Promise<{status:"pending"|"complete", cliSessionToken?, user?, organization?, membership?} | {kind:"denied"|"expired"}>`.

- [ ] **Step 1: tokens.ts:**

```ts
import { randomBytes, createHash } from "crypto";
export const newToken = (p: string) => `${p}_${randomBytes(32).toString("base64url")}`;
export const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");
```

- [ ] **Step 2: Write the failing contract test** — `tests/contract/device.test.ts`: `POST /api/v1/auth/device/start` returns `201` with `data.userCode`, `data.verificationUri` ending `/device`, `data.verificationUriComplete` containing `?code=`, and `data.pollIntervalSeconds` a number. `poll` with that `deviceAuthId` returns `200` `data.status === "pending"`.

- [ ] **Step 3: Run it** → FAIL.

- [ ] **Step 4: Implement `lib/auth/device.ts`.** `startDevice`: generate `deviceAuthId = newToken("dev")` and a 8-char `userCode`; insert a `deviceAuthRequests` row with `deviceAuthIdHash = hashToken(deviceAuthId)`, `expiresAt = now + 10min`; return the plaintext `deviceAuthId` + `verificationUri = ${APP_URL}/device`, `verificationUriComplete = ${APP_URL}/device?code=${userCode}`. `pollDevice`: look up by `hashToken(deviceAuthId)`; if expired → mark `expired`, return `{kind:"expired"}`; if `denied` → `{kind:"denied"}`; if `complete` → return `{status:"complete", cliSessionToken, user, organization, membership}` (session token was minted at approval — Task 5); else `{status:"pending"}`.

- [ ] **Step 5: Route handlers.** `start/route.ts` → `ok(await startDevice(), 201)`. `poll/route.ts` → parse `{deviceAuthId}` with Zod; map `expired`→`err(400,"device_code_expired",...)`, `denied`→`err(403,"authorization_denied",...)`, else `ok(result)`. Add IP + deviceAuthId rate limiting.

- [ ] **Step 6: Run contract test (pass) + commit.** `git commit -m "feat(device): start + poll endpoints"`.

---

### Task 5: `/device` page + approval → CLI session token

**Files:**
- Create: `lib/auth/entitlement.ts`, `lib/auth/session.ts`, `app/device/page.tsx`, `app/api/device/approve/route.ts`
- Test: `tests/unit/session.test.ts`, `tests/e2e/device-approval.spec.ts`

**Interfaces:**
- Produces: `requireEntitled(orgId, userId): Promise<{ok:true}|{ok:false,reason:"no_plan"|"no_seat"}>`; `mintSession(userId, orgId, deviceLabel?): Promise<string>` (returns plaintext CLI session token, stores only the hash); `approveDevice(deviceAuthId, userId, orgId): Promise<void>` (sets request `complete` + attaches a freshly minted session token payload for `poll` to return).

- [ ] **Step 1: entitlement.ts** — read the org's `subscriptions` row: no active sub → `no_plan`; for `team/enterprise`, require an active `memberships.seatAssigned` within `seats` → else `no_seat`; personal `free` orgs always pass.

- [ ] **Step 2: Write the failing test** — `tests/unit/session.test.ts`: `mintSession("u1","o1")` returns a token whose SHA-256 matches exactly one non-revoked `cliSessions` row for `(u1,o1)`; the plaintext is never stored.

- [ ] **Step 3: Run it** → FAIL. **Step 4: Implement `session.ts`** (`newToken("sess")`, insert `cliSessions{tokenHash}`), then `approveDevice` (guard entitlement, set `deviceAuthRequests.status="complete"`, `approvedUserId/OrgId`, and stash the minted token so the next `poll` returns it — e.g. a short-lived `pending_session_tokens` cache keyed by request id, or mint-on-approve and return via poll join). Run test → PASS.

- [ ] **Step 5: `/device` page** (`app/device/page.tsx`, Clerk-protected). Read `?code=`; if signed out, Clerk renders sign-in. When signed in: show the approval card (device/OS label, the code, the user's plan + usage), call `requireEntitled`; render **Approve** (POST `/api/device/approve` with the code + Clerk session) and **Deny**. `no_seat` → show "ask your admin"; `no_plan` → link to `/pricing`.

- [ ] **Step 6: E2E** `tests/e2e/device-approval.spec.ts` (Playwright + Clerk test mode): start a device request → visit `verificationUriComplete` → sign in (test user) → Approve → assert a subsequent `poll` returns `status:"complete"` with a `cliSessionToken`.

- [ ] **Step 7: Commit.** `git commit -m "feat(device): approval page + session token issuance"`.

---

### Task 6: Bearer auth + `/auth/me` + `/auth/logout`

**Files:**
- Create: `app/api/v1/auth/me/route.ts`, `app/api/v1/auth/logout/route.ts` (extend `lib/auth/session.ts`)
- Test: `tests/contract/me.test.ts`

**Interfaces:**
- Produces: `verifyBearer(req): Promise<{userId,orgId,sessionId} | null>` (hash the `Authorization: Bearer` token, look up a non-revoked `cliSessions` row, touch `lastUsedAt`).

- [ ] **Step 1: Write the failing contract test** — with a seeded session token: `GET /api/v1/auth/me` with `Authorization: Bearer <token>` → `200` `{data:{userId,organizationId,membershipId,role,permissions:[]}}`; with no or bad token → `401` error envelope. `POST /auth/logout` → `204` and the session is revoked (a second `me` → `401`).

- [ ] **Step 2: Run it** → FAIL.

- [ ] **Step 3: Implement `verifyBearer`** + `me/route.ts` (join membership for `role`) + `logout/route.ts` (set `revokedAt`, return `new Response(null,{status:204})`).

- [ ] **Step 4: Run contract test (pass) + commit.** `git commit -m "feat(auth): bearer auth, /auth/me, /auth/logout"`.

---

### Task 7: Runtime tokens — mint / renew / revoke

**Files:**
- Create: `lib/models/catalog.ts`, `lib/tokens/runtime.ts`, `app/api/v1/runtime-tokens/route.ts`, `.../renew/route.ts`, `.../revoke/route.ts`
- Test: `tests/contract/runtime-tokens.test.ts`

**Interfaces:**
- Consumes: `verifyBearer`, `requireEntitled`.
- Produces: `mintRuntime(session): Promise<MintResponse>`, `renewRuntime(session, tokenId): Promise<{expiresAt}>`, `revokeFamily(session, familyId): Promise<void>`.

- [ ] **Step 1: `lib/models/catalog.ts`** (verbatim aliases; **set real `maxContextSize` per deployment before launch**):

```ts
export const MODEL_CATALOG = [
  { name: "kimi-k2.7-code", maxContextSize: 256000, capabilities: ["thinking"] },
  { name: "gpt-5.3-codex",  maxContextSize: 200000, capabilities: [] },
  { name: "deepseek-v4-pro",maxContextSize: 128000, capabilities: ["thinking"] },
  { name: "codestral",      maxContextSize: 256000, capabilities: [] },
  { name: "mistral-small",  maxContextSize: 128000, capabilities: [] },
] as const;
export const DEFAULT_MODEL_ALIAS = "kimi-k2.7-code";
export const ALIAS_TO_DEPLOYMENT: Record<string,string> = {
  "gpt-5.3-codex": "gpt-5.3-codex", "kimi-k2.7-code": "FW-Kimi-K2.7-Code",
  "deepseek-v4-pro": "DeepSeek-V4-Pro", "codestral": "Codestral-2501",
  "mistral-small": "mistral-small-2503",
};
```

- [ ] **Step 2: Write the failing contract test** — `runtime-tokens.test.ts`: with a seeded session token, `POST /api/v1/runtime-tokens` → `200` and `data` has EXACTLY `token, tokenId, familyId, expiresAt, absoluteExpiresAt, gatewayBaseUrl, modelSettings, defaultModelAlias`; `modelSettings` is an array whose names equal the catalog; `defaultModelAlias === "kimi-k2.7-code"`; **no `allowedModelAliases` key**. A session on a canceled subscription → `402 "subscription_required"`.

- [ ] **Step 3: Run it** → FAIL.

- [ ] **Step 4: Implement `lib/tokens/runtime.ts`.** `mintRuntime`: `requireEntitled` (else throw a typed error the route maps to `402`/`403`); create a `runtimeTokens` row (`id=newToken("rtok")` stored hashed if the gateway validates via lookup, else signed JWT the gateway verifies — pick per gateway design; default: opaque + hashed), `familyId=newToken("fam")`, `expiresAt=now+10min`, `absoluteExpiresAt=now+24h`; return the mint response with `gatewayBaseUrl=process.env.GATEWAY_BASE_URL`, `modelSettings=MODEL_CATALOG`, `defaultModelAlias=DEFAULT_MODEL_ALIAS`. `renewRuntime`: if `now < absoluteExpiresAt` and not revoked, bump `expiresAt`, return `{expiresAt}`. `revokeFamily`: set `revokedAt` on all rows with `familyId`.

- [ ] **Step 5: Route handlers** (all `verifyBearer` first; `renew` body `{tokenId}`, `revoke` body `{familyId}` → `204`). Map entitlement failures: `no_plan`→`402 "subscription_required"`, `no_seat`→`403 "no_seat"`.

- [ ] **Step 6: Run contract test (pass) + commit.** `git commit -m "feat(tokens): runtime-token mint/renew/revoke + model catalog"`.

---

### Task 8: Dashboard + usage widget + device management

**Files:**
- Create: `app/dashboard/page.tsx`, `lib/usage.ts`, `app/api/dashboard/sessions/route.ts` (list/revoke)
- Test: `tests/unit/usage.test.ts`

**Interfaces:**
- Produces: `usageSummary(orgId): Promise<{ used:number, limit:number, byModel: {alias:string,tokens:number}[], periodEnd:string }>` (aggregate `usageEvents` for the current period; `limit` from `subscriptions.quota`).

- [ ] **Step 1: Write the failing test** — seed `usageEvents` for an org; `usageSummary(orgId)` returns `used` = sum of tokens and `limit` from the free-plan quota.

- [ ] **Step 2: Run it** → FAIL. **Step 3: Implement `lib/usage.ts`** (Drizzle aggregate query). Run → PASS.

- [ ] **Step 4: Dashboard page** (Clerk-protected): render the **usage widget** (`used / limit`, per-model breakdown — this is the day-one requirement), the current plan (link to `/pricing`), and the **device/session list** with a per-row "sign out" that POSTs to `app/api/dashboard/sessions/route.ts` (sets `cliSessions.revokedAt`). Usage numbers come from `usageEvents`, which the gateway (#3) will populate — seed a few rows so the widget renders now.

- [ ] **Step 5: Commit.** `git commit -m "feat(dashboard): usage widget + device management"`.

---

### Task 9: Contract-oracle test suite + live E2E wiring

**Files:**
- Create: `tests/contract/oracle.test.ts`, `README.md` (run + deploy notes)

- [ ] **Step 1: Oracle suite.** For every frozen endpoint, assert the response matches the spec §4 shapes with a Zod schema mirroring the CLI's models (`DeviceStart`, `DevicePoll`, `Me`, `MintResponse`). This is the regression guard that the CLI will keep working. Run → PASS.

- [ ] **Step 2: Live E2E note (README).** Document: deploy a Vercel preview, set `SANAD_API_BASE_URL=<preview-url>` and run the CLI repo's gated `tests/sanad/test_integration.py` against it (drives real `sanad login` → mint → stream → revoke). Also document required env: `DATABASE_URL`, Clerk keys, `GATEWAY_BASE_URL`, `APP_URL`, Clerk webhook secret.

- [ ] **Step 3: Commit.** `git commit -m "test: contract oracle + e2e wiring docs"`.

---

## Self-Review

- **Spec coverage:** §4 contract → Tasks 4,5,6,7,9. §5 flow → 4,5,7. §6 components/data → 2,3,5,8. §7 entitlement → 3,5,7. §8 errors → mapped in 4,6,7. §9 security → tokens hashed (2,4,5), rate limits (4), Clerk-gated approval (5). §10 testing → every task + 9. Usage widget (day-one) → 8. Deferred (#2 billing, #3 gateway/metering, #4 install) intentionally absent.
- **Placeholders:** none — `maxContextSize` values flagged as "set real values" (a data decision, not a code gap); the runtime-token storage choice (opaque-hashed vs signed JWT) is called out as depending on the separate gateway's validation and given a default.
- **Type consistency:** `newToken/hashToken`, `verifyBearer`, `requireEntitled`, `mintSession`, the mint-response field set, and `MODEL_CATALOG`/`DEFAULT_MODEL_ALIAS` are used consistently across Tasks 4–8.
