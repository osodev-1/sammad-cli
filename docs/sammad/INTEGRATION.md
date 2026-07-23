# sammad — fork integration & plan

sammad is a governed, SSO-first fork of **Kimi Code CLI** (`MoonshotAI/kimi-cli`,
Apache-2.0). Upstream ships a complete terminal coding agent; sammad skins it and
wires it to an organization's identity and model governance. The governance
backend (control plane + LLM gateway) lives in a separate repository and is
consumed over HTTP — this fork only changes the *client*.

## Upstream provenance

- Forked from `MoonshotAI/kimi-cli` at `v1.49.0` (`kosong==0.55.0`).
- License: Apache-2.0 (see `LICENSE`, `NOTICE`).
- Rebase procedure: add upstream as a remote (`git remote add upstream
  https://github.com/MoonshotAI/kimi-cli`), `git fetch upstream`, rebase
  `sammad/*` branches onto the target tag, resolve conflicts (our changes are
  deliberately localized — see "Change surface" — to keep rebases cheap), re-run
  tests, update the pinned version here and in `NOTICE`.

## The model seam (confirmed)

`kimi-cli` already supports a fully configurable OpenAI-compatible provider —
no model-layer fork needed. From `src/kimi_cli/config.py`:

```python
class LLMProvider(BaseModel):
    type: ProviderType        # "openai_legacy" | "openai_responses" | ...
    base_url: str
    api_key: SecretStr

class LLMModel(BaseModel):
    provider: str
    model: str
```

sammad configures this to point at the internal gateway:

| field | value |
|---|---|
| `provider.type` | `openai_legacy` (OpenAI-compatible chat completions) |
| `provider.base_url` | the gateway URL from the runtime-token mint response |
| `provider.api_key` | the short-lived **runtime token** (never a provider key) |
| `model.model` | the org model alias, e.g. `agent-default` |

The gateway is the sammad LLM gateway from the backend repo: it validates the
runtime token, resolves the alias to an Azure AI Foundry deployment server-side,
enforces quotas, and streams normalized OpenAI SSE back.

## SSO + credential flow (to build)

`sammad login` runs the brokered Entra **device authorization grant** against the
backend control plane (never a public Entra client; the CLI only ever holds an
opaque session token), stores that token in the **OS keychain** (`keyring`), then
mints a runtime token and writes the provider config above. A background renewal
keeps the runtime token alive while the agent runs; `sammad logout` revokes it.

This mirrors the backend contracts already built and tested:
`POST /api/v1/auth/device/{start,poll}`, `GET /auth/me`, `POST /auth/logout`,
`POST /api/v1/runtime-tokens{,/renew,/revoke}`.

## Change surface (keep localized for cheap rebases)

- `src/kimi_cli/sammad/` — new package: device-flow client, keychain store,
  runtime-token mint/renew, gateway provider wiring. All net-new; no upstream
  conflicts.
- `src/kimi_cli/constant.py` — `NAME` and brand strings.
- CLI entry (`__main__` / command wiring) — register `sammad login/logout/whoami`
  and the brand banner; keep upstream commands.
- `pyproject.toml` — package name, `[project.scripts]` add `sammad = …`, add deps
  (`keyring`, `httpx`).
- theme/banner assets — the sammad palette (gold/sand on ink, rust accent) and
  logo, carried over from the backend repo's CLI design reference.

## Phased plan

1. **Provenance + scaffold** ✅: attribution, this doc, an empty
   `src/kimi_cli/sammad/` package, dev bring-up notes.
2. **Backend client** ✅: typed device-flow + runtime-token client (`httpx`),
   keychain store, unit tests against the backend's fake-IdP stack (`pnpm demo`).
3. **Provider wiring** ✅: build the `LLMProvider`/`LLMModel` config from a mint
   response; `sammad run` uses it; verify a streamed turn through the gateway.
4. **Login UX + renewal + logout** ✅: `sammad login/whoami/logout/doctor`, the
   session service (`session.py`) that owns the token lifecycle, and the
   in-place runtime-token renewer (ADR-017). Commands live in `sammad/cli.py`
   behind a `sammad` console-script entry point; `sammad run` mints a token,
   writes the gateway provider config, starts renewal, and launches the agent.
5. **Skin** ✅ (text/theme; binary icon pending the logo file): product name
   rebranded via `constant.NAME` (`sammad`, with `UPSTREAM_NAME` kept for
   attribution — flows through the ACP/wire handshakes, telemetry app name, and
   user agent); the shell welcome uses the sammad cross-stitch mark and palette
   (`branding.SHELL_LOGO`/`WELCOME`, gold panel border); `--version` on both the
   `sammad` and `kimi` entry points prints sammad + upstream provenance, and
   `sammad about` shows the full banner. Process title is `sammad`. Remaining:
   the favicon/app-icon needs the transparent logo PNG committed to the repo.
6. **Harden + docs**: opt-in real-Entra/Foundry smoke, rebase test against a newer
   upstream tag, onboarding.

## Command surface (phase 4)

| command | what it does |
|---|---|
| `sammad login` | Entra device flow → stores the opaque session token in the OS keychain |
| `sammad whoami` | shows the signed-in identity, org, and role from `GET /auth/me` |
| `sammad logout` | best-effort server logout, then clears the local credential |
| `sammad doctor` | checks keychain, control-plane reachability, and session validity |
| `sammad run [args…]` | mints a runtime token, writes the gateway provider config, starts renewal, and launches the kimi agent; extra args pass through |
