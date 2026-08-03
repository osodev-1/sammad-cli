# Replit kickoff prompt — sanadcode.com control plane

Paste the block below into a fresh Replit AI-agent session, then paste the two documents
it references (`2026-08-03-sanad-auth-flow-design.md` and `2026-08-03-sanad-auth-flow.md`)
right after it.

---

You are building the **control plane + web app for sanadcode.com** — the backend that an
already-shipped CLI called `sanad` talks to. Your job is to implement **Spec #1 (auth +
entitlement flow)** exactly as designed.

**I will paste two documents after this message:**
1. **Design spec** — the architecture and the *frozen* HTTP contract the CLI depends on.
2. **Implementation plan** — 9 tasks in build order, each with tests and a commit.

**Non-negotiable:** the `sanad` CLI is already shipped and frozen. The endpoints, JSON field
names, and response envelope in the spec are a hard contract — **do not rename or reshape
them.** When anything is ambiguous, match the spec.

**Stack — use exactly:** Next.js 15 (App Router, TypeScript) · Clerk (`@clerk/nextjs`) ·
Drizzle ORM + Neon serverless Postgres · Zod · Vitest (unit/contract) + Playwright (e2e).
Deploy target: Vercel.

**How to work:**
- Implement **Task 1 → Task 9 in order.** Do not skip ahead.
- Each task is TDD: write the failing test, run it and confirm it fails, write the minimal
  implementation, run it and confirm it passes, then commit. Each task ends **green +
  committed.**
- **Pause after each task** and show me the diff + passing tests before continuing.
- Treat the cheat-sheet below as a safety net; the spec is authoritative.

**Frozen contract cheat-sheet:**
- Envelope — success: `{ "data": <payload>, "meta": { "requestId": "<uuid>" } }`; error:
  `{ "error": { "code", "message", "requestId", "retryable": <bool> } }`. **All field names
  camelCase.** Timestamps ISO-8601 UTC.
- Auth — authenticated endpoints require `Authorization: Bearer <cliSessionToken>` (the CLI
  is **not** a browser; never expect a Clerk cookie).
- Endpoints — `POST /api/v1/auth/device/{start,poll}` · `GET /api/v1/auth/me` ·
  `POST /api/v1/auth/logout` · `POST /api/v1/runtime-tokens{,/renew,/revoke}`.
- Mint response — `{ token, tokenId, familyId, expiresAt, absoluteExpiresAt, gatewayBaseUrl,
  modelSettings: [{ name, maxContextSize, capabilities }], defaultModelAlias }`. There is
  **no** `allowedModelAliases` field.
- Subscriptions are **org-scoped**; every self-serve user gets a **personal org of one** on
  the `free` plan. Active-plan/seat is checked **at runtime-token mint**; usage quota is
  enforced by the (separate) gateway — out of scope for this build.

**Before you start, provision:**
- A **Clerk** application — enable Email, Google, GitHub, and one SAML/enterprise SSO
  connection (that connection is where Microsoft Entra plugs in later).
- A **Neon** Postgres database (`DATABASE_URL`).
- Env vars: `DATABASE_URL`, Clerk publishable + secret keys + webhook signing secret,
  `GATEWAY_BASE_URL`, `APP_URL`.

**Start now with Task 1** (scaffold + response envelope + health check). When it's green and
committed, show me the result and wait for my go-ahead before Task 2.

---

*(After #1 is built and deployed, the same repo grows to cover platform specs #2 billing,
#3 gateway + usage metering, and #4 download/install — each has its own spec.)*
