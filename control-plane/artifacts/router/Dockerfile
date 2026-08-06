# syntax=docker/dockerfile:1
#
# sanad-router — the single ingress behind the AWS ALB for per-user workspace
# tasks (host/path routing + WS passthrough + preview security headers).
#
# Build context = the pnpm workspace root (control-plane/):
#     docker build -f artifacts/router/Dockerfile -t sanad-router .
# ROUTER_SHARED_SECRET etc. are injected at runtime — never baked in.

FROM node:22-slim AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@10.34.5 --activate
WORKDIR /workspace

FROM base AS build
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile
RUN pnpm --filter @workspace/router build

FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
COPY --from=build /workspace/artifacts/router/dist ./dist
EXPOSE 8080
CMD ["node", "dist/index.mjs"]
