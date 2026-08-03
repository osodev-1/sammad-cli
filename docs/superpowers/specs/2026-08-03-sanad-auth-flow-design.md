# sanad — Auth & Entitlement Flow (Design Spec)

**Status:** Approved design · **Spec 1 of 4** for the sanadcode.com platform · 2026-08-03
**Target stack:** Next.js on Vercel (built on Replit) + Clerk + Postgres + Stripe
**Audience:** whoever implements the sanadcode.com control plane (the CLI already exists and is frozen)

---

## 1. Purpose & context

`sanad` is a governed, subscription-gated CLI coding agent. The **CLI is already built,
shipped, and frozen** (a fork of Kimi Code CLI). It signs users in over a device flow and
routes every model call through a gateway backed by Azure AI Foundry — users never hold a
personal provider key.

This spec covers the **web + control-plane** side that the CLI talks to: the
`sanadcode.com` Next.js app that handles sign-in, the subscription gate, device approval,
and issuing the tokens the CLI needs. Because the CLI is frozen, **the app must implement
the exact HTTP contract in §4** — that contract is authoritative, not negotiable.

The **LLM gateway** (validates runtime tokens, proxies to Azure Foundry, streams, meters)
stays a **separate service** — Vercel serverless is a poor fit for long-lived streaming
proxies. This spec defines the *token* the gateway consumes, not the gateway itself.

## 2. Locked decisions

| Decision | Choice |
|---|---|
| Identity | **Hybrid** — self-serve accounts *and* enterprise SSO, from day one |
| Auth platform | **Clerk** (email + social + enterprise SSO incl. Entra as one connection) |
| Architecture | **Consolidated** — the Next.js app *is* the control plane the CLI calls |
| Monetization | **Freemium** — sign-up grants a free quota; paid plans raise the ceiling |
| Subscription ownership | **Org-scoped, always** — every self-serve user gets a *personal org of one*; entitlement is uniformly "your org's plan + your seat" |

## 3. Scope

**In scope (this spec, #1):**
- Hybrid sign-in via Clerk (the `/device` approval page + account pages).
- The full CLI-facing HTTP contract (§4): device flow, `/auth/me`, logout, runtime-token
  mint/renew/revoke.
- The entitlement model (free tier, seats) and where it is checked.
- The data model, token model, error handling, security, and testing approach.

**Out of scope — follow-on specs:**
- **#2 Billing internals** — Stripe plan config, checkout, webhooks, pricing/account UI,
  seat management, enterprise org onboarding. (#1 treats "is this org entitled?" as an
  interface.)
- **#3 Gateway + usage metering** — the Azure Foundry proxy, per-call metering, quota
  *enforcement*. (#1 defines the `usage_events` shape and the runtime token it validates.)
- **#4 Download & install** — cross-platform one-liner installers + the `/download` page.

## 4. The CLI contract (authoritative — implement exactly)

**Base URL:** `https://sanadcode.com` — the API lives under the `/api/v1/...` path (no
subdomain). The CLI reads its base from `SANAD_API_BASE_URL` (default will be
`https://sanadcode.com`).

**Envelope (every response):**
- Success: `2xx` with `{ "data": <payload>, "meta": { "requestId": "<id>" } }`
- Error: `{ "error": { "code": "<machine_code>", "message": "<human>", "requestId": "<id>", "retryable": <bool> } }`
- **All JSON field names are camelCase.** Timestamps are ISO-8601 UTC (trailing `Z` ok).
- Authenticated endpoints require `Authorization: Bearer <cliSessionToken>`.

**Endpoints the CLI calls (frozen shapes):**

| Method & path | Auth | Request | Success response (`data`) |
|---|---|---|---|
| `POST /api/v1/auth/device/start` | none | — | `201` · `{ deviceAuthId, userCode, verificationUri, verificationUriComplete?, expiresAt, pollIntervalSeconds }` |
| `POST /api/v1/auth/device/poll` | none | `{ deviceAuthId }` | `200` · `{ status: "pending" \| "complete", cliSessionToken?, user?: {id,email,displayName?}, organization?: {id,name,slug}, membership?: {id,role} }` |
| `GET /api/v1/auth/me` | bearer | — | `200` · `{ userId, organizationId, membershipId, role, permissions: string[] }` |
| `POST /api/v1/auth/logout` | bearer | — | `204` |
| `POST /api/v1/runtime-tokens` | bearer | — | `200` · mint response (below) |
| `POST /api/v1/runtime-tokens/renew` | bearer | `{ tokenId }` | `200` · `{ expiresAt }` |
| `POST /api/v1/runtime-tokens/revoke` | bearer | `{ familyId }` | `204` |

**Mint response** (`POST /api/v1/runtime-tokens`) — carries the model catalog the CLI
registers for in-session `/model <alias>` switching:

```jsonc
{
  "token": "<opaque runtime token the gateway validates>",
  "tokenId": "<id>",
  "familyId": "<id, used by revoke>",
  "expiresAt": "<ISO>",
  "absoluteExpiresAt": "<ISO, hard cap the CLI stops renewing at>",
  "gatewayBaseUrl": "https://<gateway-host>/v1",
  "modelSettings": [
    { "name": "<alias>", "maxContextSize": <int>, "capabilities": ["thinking"?] }
    // one entry per allowed alias; capabilities recognized by the CLI: "thinking"
  ],
  "defaultModelAlias": "<one of the names above>"
}
```

**Alias → Azure Foundry deployment map** (the gateway resolves these; the control plane
returns the aliases as `modelSettings[].name`):

| alias | deployment | default |
|---|---|---|
| `gpt-5.3-codex` | `gpt-5.3-codex` | |
| `kimi-k2.7-code` | `FW-Kimi-K2.7-Code` | ✓ |
| `deepseek-v4-pro` | `DeepSeek-V4-Pro` | |
| `codestral` | `Codestral-2501` | |
| `mistral-small` | `mistral-small-2503` | |

**Reference implementation of the shapes:** the CLI repo's `scripts/demo_backend.py` is a
zero-dependency stand-in that returns exactly these responses — use it as the contract
oracle and to smoke-test the CLI against a local stub.

## 5. The flow

**Happy path — `sanad login` (self-serve, first run):**

1. **CLI** → `POST /api/v1/auth/device/start` → app creates a `device_auth_requests` row
   (`pending`, 10-min expiry) and returns `userCode` + `verificationUri` (`/device`) +
   `verificationUriComplete` (`/device?code=XXXX`).
2. **CLI** prints the URL + code, opens the browser, polls `…/device/poll` at the interval.
3. **Browser** → `/device`. Not signed in → **Clerk** sign-in (email / social / org SSO).
   A brand-new user → app auto-provisions a **personal org (of one)** on the **free plan**.
4. Signed in → `/device` shows a one-click **approval card**: "The sanad CLI on *[OS/device]*
   wants to connect · code `XXXX`" + current plan & usage. **Entitlement check:**
   - Self-serve → entitled (free tier).
   - Org SSO → **seat check** against the org's plan; no seat → "ask your admin," stop.
5. **Approve** → app marks the request `complete`, mints an **opaque CLI session token**
   bound to `(user, org)`.
6. **CLI's** next poll returns `{ status: "complete", cliSessionToken, user, organization,
   membership }` → stored in the OS keychain. Done.
7. Later, **`sanad run`** → `POST /api/v1/runtime-tokens` → app re-checks entitlement →
   mints a short-lived runtime token + gateway URL + model catalog → CLI streams through the
   gateway, which meters each call.

**Branches:** not-signed-in → Clerk · new user → free personal org · org-SSO no-seat →
blocked · device code expired → CLI times out (re-run) · user denies → poll `denied` ·
free quota exhausted → gateway `429` → CLI prints "quota reached — upgrade."

## 6. Components

### 6.1 Web pages (Next.js / Vercel)
- `/` + `/pricing` — marketing + freemium tiers.
- Clerk sign-in/up (hosted or embedded components).
- **`/device`** — the device-approval card (the heart of the flow).
- `/dashboard` — subscription management (Stripe, #2) · **usage widget (day-one requirement)** ·
  device/session list with per-device "sign out".
- `/download` — install one-liners (mechanics in #4).

### 6.2 The identity split
| Clerk owns | Our Postgres owns |
|---|---|
| sign-in, browser sessions, users, orgs, SSO connections (incl. Entra), MFA | device requests, CLI session tokens, subscriptions/entitlements, runtime tokens, usage |

Web pages are Clerk-protected. On **Approve**, the app reads the Clerk-authenticated user
and mints *our own* CLI token. Our rows key off Clerk `userId` / `orgId`.

### 6.3 Two tokens, kept distinct
- **CLI session token** — opaque, issued on approval, stored in the OS keychain, **hashed at
  rest**; long-lived + revocable. Authenticates `/auth/me`, `/logout`, `/runtime-tokens`.
  The CLI is not a browser and never holds a Clerk cookie.
- **Runtime token** — short-lived (minutes), minted per `sanad run` from a valid session
  token; carries the gateway URL + model catalog; the gateway validates it and meters usage;
  renewed in place by the CLI until `absoluteExpiresAt`; revocable by `familyId`.

### 6.4 Data model (our tables; users/orgs mirror Clerk)
- `organizations` — `id` (Clerk org id), `name`, `slug`, `type` (`personal`|`team`), `createdAt`.
- `users` — `id` (Clerk user id), `email`, `displayName`, `createdAt`.
- `memberships` — `id`, `orgId`, `userId`, `role`, `seatAssigned` (bool), `createdAt`.
- `subscriptions` — `id`, `orgId` (owner), `plan`, `status` (`active`|`past_due`|`canceled`),
  `stripeCustomerId`, `stripeSubscriptionId`, `seats`, `quota` (jsonb limits),
  `currentPeriodEnd`.
- `device_auth_requests` — `id`, `deviceAuthIdHash` (the CLI's poll credential, hashed),
  `userCode`, `status` (`pending`|`complete`|`denied`|`expired`), `approvedUserId`,
  `approvedOrgId`, `expiresAt`, `pollIntervalSeconds`, `createdAt`.
- `cli_sessions` — `id`, `tokenHash`, `userId`, `orgId`, `deviceLabel`, `createdAt`,
  `lastUsedAt`, `revokedAt`.
- `runtime_tokens` — `id` (= `tokenId`), `familyId`, `cliSessionId`, `expiresAt`,
  `absoluteExpiresAt`, `revokedAt`, `createdAt`.
- `usage_events` — `id`, `orgId`, `userId`, `cliSessionId`, `modelAlias`, `tokensIn`,
  `tokensOut`, `cost`, `createdAt`. Aggregated (view or rollup) for the widget + quota.

## 7. Entitlement model

- **Everything is org-scoped.** Self-serve users own a personal org of one; enterprise users
  belong to their real (SSO-provisioned) org. Subscriptions attach to the org.
- **Free tier** = a personal org on the `free` plan with a capped `quota`.
- **Seats** = enterprise orgs assign seats (`memberships.seatAssigned`) up to
  `subscriptions.seats`; a member without a seat is not entitled.
- **Two checkpoints, deliberately different:**
  - **Active plan / seat** is checked at **runtime-token mint** (`POST /runtime-tokens`) —
    no active plan or no seat → error, no token minted.
  - **Usage quota** is enforced at the **gateway** (the only place that sees real token
    counts) → `429` with an upgrade message the CLI surfaces.

## 8. Error handling & edge cases

- **Poll:** `pending` → keep polling (honor `pollIntervalSeconds`; may return a `slow_down`
  code); `expired` (10-min code) → error, CLI times out and asks the user to re-run;
  `denied` → error, CLI aborts cleanly.
- **Org-SSO, no seat:** `/device` blocks approval → "ask your admin to assign a seat"; the
  request expires. New SSO org is JIT-created in Clerk on first sign-in with **no plan** →
  members blocked until an admin subscribes (onboarding detail lives in #2).
- **Revocation:** dashboard "sign out device" or a lapsed subscription clears the
  `cli_sessions` row → `/auth/me` + `/runtime-tokens` return `401` → the CLI already tells the
  user to run `sanad login`. Runtime tokens are short-lived + family-revocable.
- **Idempotency:** `device/start` is safe to retry; `poll` is read-mostly; mint is not
  idempotent (each call is a new token family).

## 9. Security

- `deviceAuthId` (the CLI's poll credential) and `userCode` are single-use and rate-limited;
  store only a **hash** of the `deviceAuthId`.
- CLI session tokens and runtime tokens are random high-entropy secrets, **hashed at rest**;
  never logged.
- Approval **always** requires an authenticated Clerk session — no blind/unauthenticated
  approvals; the approval is bound to the signed-in user.
- HTTPS only; short runtime-token lifetimes; family revocation kills a leaked token set.
- Standard rate limits on `device/start`, `device/poll`, and `runtime-tokens`.

## 10. Testing

The contract already exists, which makes this tractable:
- **Contract oracle:** the CLI's response models and `scripts/demo_backend.py` define the
  exact shapes — build a contract-test suite that asserts each endpoint matches.
- **Unit:** the device-flow state machine, entitlement/seat checks, token issue/renew/revoke.
- **Integration:** Clerk **test mode** for sign-in; Stripe test mode for billing (#2).
- **E2E:** the CLI repo's gated `tests/sammad/test_integration.py` already drives a real
  `sanad login` → mint → streamed turn → revoke against a demo backend — **point it at a
  Vercel preview deploy** and it becomes the live end-to-end test. `test_smoke.py` covers a
  real gateway turn.

## 11. Open questions / deferred

- **Free-tier quota numbers** (requests or tokens/month) → decide in #2 (billing).
- **Usage endpoint for the CLI:** the dashboard widget is day-one; exposing usage to a
  `sanad usage` command needs a small CLI addition + a `GET /api/v1/usage` endpoint — track
  as a minor follow-on, not part of #1's frozen contract.
- **Enterprise org onboarding** (who subscribes an SSO org, seat self-service) → #2.
- **CLI rename `sammad` → `sanad`** and default base URL → separate CLI change, already
  scoped, independent of this backend work.
