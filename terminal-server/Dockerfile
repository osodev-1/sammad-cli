# syntax=docker/dockerfile:1
# sanad-terminal — WS PTY bridge + workspace API running the governed sanad agent.
#
# Build context = the REPO ROOT (uv workspace):
#     docker build -f terminal-server/Dockerfile -t sanad-terminal .
#
# No build-time secrets — TERMINAL_SHARED_SECRET etc. are Railway runtime vars.

FROM python:3.14-slim-bookworm AS build
COPY --from=ghcr.io/astral-sh/uv:0.8.5 /uv /bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=0
WORKDIR /app
# CHANGELOG.md/LICENSE are symlink targets inside src/ and packages/ — the
# kimi-cli wheel build reads them through those links.
COPY pyproject.toml uv.lock README.md CHANGELOG.md LICENSE ./
COPY packages/ packages/
COPY sdks/ sdks/
COPY src/ src/
COPY terminal-server/ terminal-server/
# --no-editable → workspace members are installed as built wheels: the venv is
# self-contained and is the ONLY thing shipped to the runner.
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-editable --package sanad-terminal

# ---- shared runtime base ----------------------------------------------------
FROM python:3.14-slim-bookworm AS base-runner
# Agent-workspace runtime: shell + git for the agent's tools, ripgrep so the
# CLI's grep tool finds `rg` on PATH (and never curl-installs from the kimi
# CDN), tini to reap orphaned PTY children.
RUN apt-get update && apt-get install -y --no-install-recommends \
      bash git ripgrep curl ca-certificates procps tini openssh-client \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/.venv /app/.venv
ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONUTF8=1
ENTRYPOINT ["tini", "--"]
CMD ["sanad-terminal"]

# ---- railway target (legacy shared multi-user container) --------------------
FROM base-runner AS runner
ENV PORT=8080 \
    USERS_DIR=/data/users
EXPOSE 8080

# ---- task target (per-user AWS compute machine) -----------------------------
# One user per task: agentd (root) + the agent PTY as unprivileged `dev`.
# Adds the user-facing dev toolchains (Node 22 + corepack, uv) so agent-built
# projects can install and run dev servers on the preview ports.
FROM base-runner AS task
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && corepack enable \
    && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:0.8.5 /uv /usr/local/bin/uv
RUN useradd --create-home --shell /bin/bash --uid 1000 dev
ENV PORT=7070 \
    WORKSPACE_MODE=task \
    AGENT_USER=dev \
    DATA_DIR=/data
EXPOSE 7070 3000 5173 8000 8080
