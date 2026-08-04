# sanad Control Plane

The sanadcode.com control plane — a Next.js 15 App Router app that authenticates CLI users via a device flow, gates them by subscription, and issues the tokens the frozen `sanad` CLI needs to log in and run.

## Run & Operate

- `sanad-web` workflow (port 3000) — Next.js dev server; starts automatically
- `artifacts/api-server: API Server` workflow (port 8080) — shared Express health-check service
- `pnpm --filter @workspace/sanad-web run db:generate` — regenerate Drizzle migration SQL from schema
- `pnpm --filter @workspace/sanad-web run db:migrate-neon` — apply migrations to Neon via HTTP (use this instead of db:push)
- `pnpm --filter @workspace/sanad-web run typecheck` — TypeScript check for the Next.js app

## One-time Setup Checklist

### 1. Neon Postgres

Set `NEON_DATABASE_URL` to the **full connection string** from your Neon dashboard:

1. Open [console.neon.tech](https://console.neon.tech)
2. Select your project → **Connect** → **Connection string** tab
3. Copy the string — it must start with `postgresql://` and include username + password:
   ```
   postgresql://neondb_owner:AbCdEf@ep-bold-frost-xxx.us-east-2.aws.neon.tech/neondb?sslmode=require
   ```
4. In Replit: open **Secrets** (lock icon) → set `NEON_DATABASE_URL` to that full string
5. Run: `pnpm --filter @workspace/sanad-web run db:migrate-neon`

### 2. Clerk Setup

You need an **external Clerk account** (Replit-managed Clerk doesn't support org tenants or SAML).

Required secrets (already set):
- `CLERK_PUBLISHABLE_KEY` — from Clerk dashboard → API Keys
- `CLERK_SECRET_KEY` — from Clerk dashboard → API Keys

In your Clerk dashboard:
- Enable sign-in providers: Email, Google, GitHub
- Add one SAML/enterprise connection for Microsoft Entra
- Go to **Webhooks** → Add endpoint → URL: `https://sanadcode.com/api/webhooks/clerk`
- Subscribe to the `user.created` event
- Copy the signing secret → set as `CLERK_WEBHOOK_SECRET` in Replit Secrets

### 3. App & Gateway URLs

- `APP_URL` — your public domain (e.g. `https://sanadcode.com`)
- `GATEWAY_BASE_URL` — the LLM gateway base URL (e.g. `https://gateway.sanadcode.com/v1`)

## Stack

- **Runtime**: Next.js 15.2.9 (App Router, TypeScript), Node.js 24
- **Auth**: Clerk (external account — requires SAML/enterprise SSO features)
- **DB**: Neon serverless Postgres + Drizzle ORM
- **Validation**: Zod
- **Deployment target**: Vercel

## Where Things Live

```
artifacts/sanad-web/
├── app/
│   ├── globals.css                 # Monochrome design tokens + responsive helper classes
│   ├── ui/theme.ts                 # Shared control vocabulary (buttons, cards, state styles)
│   ├── ui/Nav.tsx                  # The one navigation bar, used by every page
│   ├── ui/icons.tsx                # Monochrome line icons (no emoji anywhere)
│   ├── page.tsx                    # Marketing home page
│   ├── pricing/page.tsx            # Pricing tiers
│   ├── device/page.tsx             # CLI device approval (Clerk-protected)
│   ├── dashboard/page.tsx          # Usage widget + session management (Clerk-protected)
│   ├── dashboard/team/page.tsx     # Seat management (Clerk-protected)
│   └── api/
│       ├── health/route.ts
│       ├── v1/auth/device/start/   # POST — CLI device flow start
│       ├── v1/auth/device/poll/    # POST — CLI device flow poll
│       ├── v1/auth/me/             # GET  — bearer auth → user info
│       ├── v1/auth/logout/         # POST — revoke CLI session
│       ├── v1/runtime-tokens/      # POST — mint runtime token
│       ├── v1/runtime-tokens/renew/# POST — renew runtime token
│       ├── v1/runtime-tokens/revoke/# POST — revoke token family
│       ├── device/approve/         # POST — web approval action
│       └── webhooks/clerk/         # POST — Clerk user.created webhook
├── lib/
│   ├── http/envelope.ts            # ok() / err() response helpers
│   ├── db/schema.ts                # Drizzle schema (8 tables)
│   ├── db/index.ts                 # Neon HTTP client
│   ├── auth/tokens.ts              # newToken() / hashToken()
│   ├── auth/device.ts              # startDevice() / pollDevice()
│   ├── auth/session.ts             # mintSession() / verifyBearer() / revokeSession()
│   ├── auth/entitlement.ts         # requireEntitled()
│   ├── clerk/provisioning.ts       # provisionPersonalOrg()
│   ├── models/catalog.ts           # MODEL_CATALOG, DEFAULT_MODEL_ALIAS
│   └── tokens/runtime.ts           # mintRuntime() / renewRuntime() / revokeFamily()
├── drizzle/                        # Generated migration SQL
└── scripts/migrate.ts              # Neon HTTP migration runner
```

## Architecture Decisions

- **Tokens stored as SHA-256 hashes** — plaintext CLI session and runtime tokens are never persisted; only their hashes are stored. Plaintext is returned once on mint/approve.
- **Personal org provisioned on first approval** — `provisionPersonalOrg()` is called idempotently at device approval (and via Clerk webhook for immediate provisioning). Personal org ID = `personal_<userId>`.
- **`pendingSessionToken` pattern** — the CLI session token minted at device approval is stored in plaintext temporarily in `device_auth_requests.pending_session_token`, consumed on the first `poll` call that returns `status: complete`, then cleared.
- **Runtime tokens are opaque, not JWTs** — stored as a hash; the gateway validates via lookup (not signature). Switch to JWTs in Spec #3 if the gateway warrants it.
- **Replit dev vs. production routing** — in Replit, Next.js runs on port 3000 via a custom workflow. In production on Vercel, the entire app (pages + API) is deployed as one unit.

## Design System — "Printed Terminal"

Strictly monochrome: ink on paper white, structure from hairline rules and whitespace, monospace as
the recurring accent. There is no chromatic colour anywhere and no emoji.

- **Tokens** live in `app/globals.css` (`--paper`, `--ink` / `--ink-soft` / `--ink-muted`, `--rule`,
  `--invert-surface`, radii, shadow, fonts). Never hardcode a hex in a page.
- **Controls** live in `app/ui/theme.ts`: `button.primary` (solid ink pill), `button.secondary`
  (outlined pill), `button.quiet` (underlined text), `button.danger` / `button.dangerConfirm`.
  Pages compose these — they do not define their own button styles.
- **State without colour** — success is a solid ink fill with a knocked-out mark, danger is its
  outlined inverse with a cross, warning is a heavy border plus a diagonal hatch (`hatch()`), and
  errors invert to a black panel. The quota bar shifts grey → striped → solid ink with a matching
  "Near limit" / "Over limit" chip. Keep this vocabulary when adding UI; never reintroduce hue as
  the only signal.
- **Responsiveness** — inline styles can't hold media queries, so `globals.css` provides `.pad-x`,
  `.row-stack`, `.nav-hide-sm`, and `.hero-tight` helpers for the mobile breakpoints.

## Frozen CLI Contract (§4 summary)

Envelope: `{ data, meta: { requestId } }` on success; `{ error: { code, message, requestId, retryable } }` on error.  
All endpoints are at `/api/v1/...`. Authenticated endpoints require `Authorization: Bearer <cliSessionToken>`.

| Endpoint | Auth |
|----------|------|
| `POST /api/v1/auth/device/start` | None |
| `POST /api/v1/auth/device/poll` | None |
| `GET  /api/v1/auth/me` | Bearer |
| `POST /api/v1/auth/logout` | Bearer |
| `POST /api/v1/runtime-tokens` | Bearer |
| `POST /api/v1/runtime-tokens/renew` | Bearer |
| `POST /api/v1/runtime-tokens/revoke` | Bearer |

## User Preferences

- Tech stack is locked: Next.js 15, Clerk (external), Drizzle ORM + Neon, Zod
- The CLI contract is frozen — never rename or reshape endpoint fields
- Deploy target is Vercel (not Replit deployment)

## Gotchas

- `NEON_DATABASE_URL` must be the full `postgresql://...` connection string — not just the hostname. Find it in Neon → Connect → Connection string.
- `CLERK_PUBLISHABLE_KEY` is re-exposed as `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` via `next.config.ts` so you only need one secret.
- `drizzle-kit push` won't work here (needs TCP `pg`). Use `pnpm run db:migrate-neon` instead, which uses the Neon HTTP driver.
- After adding Clerk webhook endpoint, update `CLERK_WEBHOOK_SECRET` in Replit Secrets to the signing secret from the Clerk dashboard.
