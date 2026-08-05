# syntax=docker/dockerfile:1
#
# sanad-gateway (Azure Foundry proxy) — an esbuild-bundled Node service.
#
# Build context = the pnpm workspace root (control-plane/):
#     docker build -f artifacts/api-server/Dockerfile -t sanad-gateway .
# On Railway: service Root Directory = `control-plane`, Dockerfile path =
# `artifacts/api-server/Dockerfile`. Secrets (FOUNDRY_API_KEY, DATABASE_URL, …)
# are injected at runtime as service variables — never baked in.

FROM node:22-slim AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@10.34.5 --activate
WORKDIR /workspace

# ---- build: install the workspace and bundle the service with esbuild ----
FROM base AS build
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile
RUN pnpm --filter @workspace/api-server build

# ---- runner: esbuild bundles everything into dist/, so ship just node + dist ----
# (pg falls back to its pure-JS path; the externalized native deps are unused.)
FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
COPY --from=build /workspace/artifacts/api-server/dist ./dist
EXPOSE 3000
CMD ["node", "dist/index.mjs"]
