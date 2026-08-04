# sanad control plane

The web control plane for the `sanad` CLI: device-flow sign-in, subscription
gating, and runtime token minting. The CLI authenticates against `/api/v1/*`
with a bearer token rather than session cookies.

This directory is **self-contained and unrelated to the Python CLI at the
repository root**. It has its own package manager, toolchain, lockfile and
deployment target, and none of the root `Makefile` / `uv` / `pytest` tooling
applies to it. Upstream CI does not build it — every `ci-*.yml` workflow uses a
paths allowlist that does not include this folder.

## Stack

Next.js 15 (App Router) · Clerk · Drizzle ORM + Neon serverless Postgres · Zod ·
Vitest. Deploys to Vercel.

## Layout

This is a pnpm workspace:

| Path                   | What it is                                       |
| ---------------------- | ------------------------------------------------ |
| `artifacts/sanad-web`  | The Next.js control plane                        |
| `artifacts/api-server` | Express API service                              |
| `lib/db`               | Drizzle schema and database client               |
| `lib/api-zod`          | Shared Zod schemas                               |
| `lib/api-spec`         | OpenAPI specification                            |
| `lib/api-client-react` | Generated React client                           |
| `scripts`              | Operational scripts (migrations, Stripe seeding) |

## Running it

```sh
pnpm install
pnpm --filter @workspace/sanad-web run dev
```

Copy `artifacts/sanad-web/.env.example` to `.env.local` and fill it in first —
the app needs Clerk keys, a Neon connection string and Stripe price IDs. The
committed example file contains placeholders only, no live credentials.

## Tests

```sh
pnpm --filter @workspace/sanad-web run test        # vitest
pnpm --filter @workspace/sanad-web run typecheck
```
