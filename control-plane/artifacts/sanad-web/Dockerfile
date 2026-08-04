# syntax=docker/dockerfile:1
#
# sanad-web (control plane) — Next.js standalone image.
#
# Build context = the pnpm workspace root (control-plane/):
#     docker build -f artifacts/sanad-web/Dockerfile -t sanad-web .
# On Railway: set the service Root Directory to `control-plane` and the
# Dockerfile path to `artifacts/sanad-web/Dockerfile`.
#
# Secrets are injected at runtime as Railway service variables — never baked in.
# The only build arg is CLERK_PUBLISHABLE_KEY, which is publishable (not secret)
# and must be present at build time because next.config inlines it into the
# browser bundle.

FROM node:22-slim AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# Pin pnpm to the version that generated the lockfile (see root packageManager).
RUN corepack enable && corepack prepare pnpm@10.34.5 --activate
WORKDIR /workspace

# ---- build: install the workspace and emit the standalone server ----
FROM base AS build
COPY . .
# Publishable (not secret) Clerk key. next.config inlines it into the browser
# bundle at build time, so the REAL key must be supplied here — CI passes it
# from a repo variable. Prerendering the Clerk-wrapped static pages fails if it
# is absent.
ARG CLERK_PUBLISHABLE_KEY=""
# Full install: sanad-web resolves `stripe` / `stripe-replit-sync` from the
# hoisted workspace root, so a filtered install would miss them.
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile
# next build imports server modules that construct the Neon client at import
# time, so a DB URL must be present or the build throws. This is a throwaway:
# Neon's HTTP driver is lazy (no connection at build), it never reaches the
# runner stage or the client bundle, and Railway injects the real one at runtime.
RUN NEON_DATABASE_URL="postgresql://build:build@localhost:5432/build" \
    CLERK_PUBLISHABLE_KEY="${CLERK_PUBLISHABLE_KEY}" \
    pnpm --filter @workspace/sanad-web build

# ---- runner: ship only the standalone output ----
FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
# Next standalone otherwise binds to localhost, which is unreachable in a
# container; bind to all interfaces so Railway's proxy can reach it.
ENV HOSTNAME=0.0.0.0
# Standalone output is traced from the workspace root, so the server lives under
# artifacts/sanad-web/ and its node_modules sits at the output root.
COPY --from=build /workspace/artifacts/sanad-web/.next/standalone ./
COPY --from=build /workspace/artifacts/sanad-web/.next/static ./artifacts/sanad-web/.next/static
EXPOSE 3000
CMD ["node", "artifacts/sanad-web/server.js"]
