# sanad — fork integration & plan

sanad is a governed, SSO-first fork of **Kimi Code CLI** (`MoonshotAI/kimi-cli`,
Apache-2.0). Upstream ships a complete terminal coding agent; sanad skins it and
wires it to an organization's identity and model governance. The governance
backend (control plane + LLM gateway) lives in a separate repository and is
consumed over HTTP — this fork only changes the *client*.

## Upstream provenance

- Forked from `MoonshotAI/kimi-cli` at `v1.49.0` (`kosong==0.55.0`).
- License: Apache-2.0 (see `LICENSE`, `NOTICE`).
- Rebase procedure: add upstream as a remote (`git remote add upstream
  https://github.com/MoonshotAI/kimi-cli`), `git fetch upstream`, rebase
  `sanad/*` branches onto the target tag, resolve conflicts (our changes are
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

sanad configures this to point at the internal gateway:

| field | value |
|---|---|
| `provider.type` | `openai_legacy` (OpenAI-compatible chat completions) |
| `provider.base_url` | the gateway URL from the runtime-token mint response |
| `provider.api_key` | the short-lived **runtime token** (never a provider key) |
| `model.model` | an org model **alias** (e.g. `kimi-k2.7-code`), resolved to a Foundry deployment server-side |

The gateway is the sanad LLM gateway from the backend repo: it validates the
runtime token, resolves each alias to an Azure AI Foundry deployment server-side,
enforces quotas, and streams normalized OpenAI SSE back.

### Model aliases (per-alias registration)

The mint response enumerates **every alias** the caller may use — one entry per
alias — and names the default. `session.configure_run` registers each as its own
`LLMModel` (keyed by the alias name, all sharing the single `sanad-gateway`
provider) and points `default_model` at `defaultModelAlias`, so `/model <alias>`
switches models in-session without re-minting. Mint-response shape:

```jsonc
"gatewayBaseUrl": "https://<gateway>/v1",
"modelSettings": [
  {"name": "kimi-k2.7-code", "maxContextSize": <int>, "capabilities": ["thinking"]},
  {"name": "gpt-5.3-codex",  "maxContextSize": <int>, "capabilities": []}
  // … one entry per allowed alias
],
"defaultModelAlias": "kimi-k2.7-code"
```

The CLI invents nothing (ADR-014): context window and capabilities are
server-authored per alias. Only `thinking` maps to a kimi `ModelCapability`;
`tool_use` is inherent and dropped. There is no separate `allowedModelAliases`
field — the `name`s in `modelSettings` are the allowed aliases. The backend
gateway registry maps each alias to its Foundry deployment:

| alias (`/model <alias>`) | Azure Foundry deployment |
|---|---|
| `gpt-5.3-codex` | `gpt-5.3-codex` |
| `kimi-k2.7-code` (default) | `FW-Kimi-K2.7-Code` |
| `deepseek-v4-pro` | `DeepSeek-V4-Pro` |
| `codestral` | `Codestral-2501` |
| `mistral-small` | `mistral-small-2503` |

## SSO + credential flow (to build)

`sanad login` runs the brokered Entra **device authorization grant** against the
backend control plane (never a public Entra client; the CLI only ever holds an
opaque session token), stores that token in the **OS keychain** (`keyring`), then
mints a runtime token and writes the provider config above. A background renewal
keeps the runtime token alive while the agent runs; `sanad logout` revokes it.

This mirrors the backend contracts already built and tested:
`POST /api/v1/auth/device/{start,poll}`, `GET /auth/me`, `POST /auth/logout`,
`POST /api/v1/runtime-tokens{,/renew,/revoke}`.

## Change surface (keep localized for cheap rebases)

Almost everything is net-new under sanad-owned paths, so upstream rebases only
have to reconcile a handful of small, deliberate edits.

**Net-new (never conflicts):**

- `src/kimi_cli/sanad/` — the whole fork logic: settings, errors, models,
  keychain, control-plane client, session lifecycle + runtime-token renewer,
  gateway provider wiring, branding, and the `sanad` CLI commands.
- `tests/sanad/`, `docs/sanad/`, `NOTICE` (fork-attribution section).

**Modified upstream files (the entire rebase burden — keep this list exact):**

| file | change |
|---|---|
| `src/kimi_cli/constant.py` | `NAME = "sanad"` + `UPSTREAM_NAME`; user agent → `sanad/…` |
| `src/kimi_cli/cli/__init__.py` | process title + `--version` string; `~/.sanad` in the config-path help |
| `src/kimi_cli/__main__.py` | `--version` string |
| `src/kimi_cli/app.py` | drop Moonshot `/login`/`/upgrade` welcome tips; governed "Model not set" hint |
| `src/kimi_cli/ui/shell/__init__.py` | welcome logo/header/border from `sanad.branding`; suppress `/login`, `/logout`, and the `setup` alias (via `sanad.shell`); governed re-auth / "no model" hints |
| `src/kimi_cli/ui/shell/slash.py` | governed "no models" hint in `/model` |
| `src/kimi_cli/ui/shell/usage.py` | governed "no model" hint in `/usage` |
| `src/kimi_cli/share.py` | data dir default `~/.kimi` → `~/.sanad` (`get_share_dir`; `KIMI_SHARE_DIR` env name kept for test compat) |
| `src/kimi_cli/tools/plan/heroes.py` | plans dir → `~/.sanad/plans` |
| `pyproject.toml` | `[project.scripts]` `sanad = …`; deps `keyring`, `httpx` |
| `tests/acp/test_protocol_v1.py` | asserts the rebranded ACP `agent_info.name` |
| `tests/core/test_startup_imports.py` | asserts the rebranded `--version` prefix |

Verify the surface hasn't drifted before/after a rebase:

```bash
git diff --stat <base>...HEAD \
  -- ':(exclude)src/kimi_cli/sanad' ':(exclude)tests/sanad' \
     ':(exclude)docs/sanad' ':(exclude)NOTICE' ':(exclude)pyproject.toml' ':(exclude)uv.lock'
```

Anything in that output beyond the nine `src/…` files and two `tests/…` files
above is unplanned drift — fold it back into `sanad/` or document why.

## Phased plan

1. **Provenance + scaffold** ✅: attribution, this doc, an empty
   `src/kimi_cli/sanad/` package, dev bring-up notes.
2. **Backend client** ✅: typed device-flow + runtime-token client (`httpx`),
   keychain store, unit tests against the backend's fake-IdP stack (`pnpm demo`).
3. **Provider wiring** ✅: build the `LLMProvider`/`LLMModel` config from a mint
   response; `sanad run` uses it; verify a streamed turn through the gateway.
4. **Login UX + renewal + logout** ✅: `sanad login/whoami/logout/doctor`, the
   session service (`session.py`) that owns the token lifecycle, and the
   in-place runtime-token renewer (ADR-017). Commands live in `sanad/cli.py`
   behind a `sanad` console-script entry point; `sanad run` mints a token,
   writes the gateway provider config, starts renewal, and launches the agent.
5. **Skin** ✅ (text/theme; binary icon pending the logo file): product name
   rebranded via `constant.NAME` (`sanad`, with `UPSTREAM_NAME` kept for
   attribution — flows through the ACP/wire handshakes, telemetry app name, and
   user agent); the shell welcome uses the sanad cross-stitch mark and palette
   (`branding.SHELL_LOGO`/`WELCOME`, gold panel border); `--version` on both the
   `sanad` and `kimi` entry points prints sanad + upstream provenance, and
   `sanad about` shows the full banner. Process title is `sanad`. Remaining:
   the favicon/app-icon needs the transparent logo PNG committed to the repo.
6. **Harden + docs** ✅ (binary icon still pending): `sanad run` disables
   upstream telemetry (which egresses to Moonshot) and auto-update by default
   via `KIMI_DISABLE_TELEMETRY`/`KIMI_CLI_NO_AUTO_UPDATE` (operator can still
   override); an opt-in real-Foundry smoke test (`tests/sanad/test_smoke.py`,
   gated on `SANAD_SMOKE_*`) exercises mint → streamed completion → revoke
   against a live gateway; onboarding is documented in `ONBOARDING.md`; and the
   change-surface manifest above plus the drift-check command make rebases onto
   newer upstream tags cheap and reviewable.

## Command surface (phase 4)

| command | what it does |
|---|---|
| `sanad login` | Entra device flow → stores the opaque session token in the OS keychain |
| `sanad whoami` | shows the signed-in identity, org, and role from `GET /auth/me` |
| `sanad logout` | best-effort server logout, then clears the local credential |
| `sanad doctor` | checks keychain, control-plane reachability, and session validity |
| `sanad run [args…]` | mints a runtime token, writes the gateway provider config, starts renewal, and launches the kimi agent; extra args pass through |
