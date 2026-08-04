# sanad — Azure Foundry Wiring Runbook

How to connect your Azure AI Foundry deployments to the `sanad` CLI **through**
`sanadcode.com` — the governed path where the CLI never holds an Azure key.

> Prereqs: the **control plane** (`control-plane/artifacts/sanad-web`, on Vercel) and the
> **gateway** (a separate long-running service, on Railway) are deployed, sharing one
> Postgres. The CLI is done and already defaults to `https://sanadcode.com`. This runbook
> is the glue that makes real models flow.
>
> **Token model note (matches the built control plane):** the runtime token is an **opaque
> secret** (the control plane stores only its hash), *not* a signed JWT. So there is **no
> keypair** — the gateway validates the token against the control plane. And **quota is
> enforced at runtime-token mint/renew (402)** in the control plane, *not* at the gateway.

## 0. The trust chain (what you're wiring)

```
sanad CLI ──login──▶ control plane (Vercel)        ── issues ──▶ opaque runtime token (rtok_…)
   │                     (stores only the token hash)
   └──run: POST {gatewayBaseUrl}/chat/completions  (Authorization: Bearer <rtok>, model=<alias>)
                          │
                          ▼
                   gateway (Railway)  ── validates the opaque token against the control plane
                          │            ── resolves alias → deployment
                          │            ── holds FOUNDRY_API_KEY
                          ▼
                   Azure AI Foundry  ── streams the completion back ──▶ POST /api/v1/usage (meter)
```

Only one secret needs sharing: the **Foundry API key**, which lives *only* in the gateway.
The gateway learns whether a runtime token is valid by asking the control plane (or reading
the same DB) — see §2.

## 1. Gather Azure Foundry connection details

In the Azure AI Foundry portal → your resource → **Models + endpoints**, open any one
deployment → the **Endpoint** / **Consume** tab. Copy:

- **Target URI / endpoint** — e.g. `https://<resource>.services.ai.azure.com/models`
- **Key** — the resource API key
- **API version** — e.g. `2024-05-01-preview` (use whatever the Consume sample shows)
- **Deployment names** — the 5 already known (table below)

Most Foundry resources expose all catalog models through **one unified Azure AI Model
Inference endpoint** (`…/models`, with `model` = the deployment name in the body). If a
given model is instead an **Azure OpenAI** deployment, its URI is
`…/openai/deployments/{deployment}/chat/completions` (deployment in the *route*, not the
body) — the Consume tab tells you which. Handle whichever pattern the tab shows.

**Alias → deployment map (locked, and already in `lib/models/catalog.ts`):**

| alias (`/model <alias>`) | Azure Foundry deployment | default |
|---|---|---|
| `gpt-5.3-codex` | `gpt-5.3-codex` | |
| `kimi-k2.7-code` | `FW-Kimi-K2.7-Code` | ✓ |
| `deepseek-v4-pro` | `DeepSeek-V4-Pro` | |
| `codestral` | `Codestral-2501` | |
| `mistral-small` | `mistral-small-2503` | |

## 2. How the gateway validates the runtime token (no keypair)

The runtime token is opaque; the control plane's `lib/tokens/runtime.ts` stores only
`hashToken(token)` and validates by DB lookup (`verifyRuntimeBearer`). The gateway needs the
same check before it proxies. Two ways — pick one:

- **Shared DB (simplest).** Give the gateway the same `DATABASE_URL` and have it run the same
  lookup: `SELECT … FROM runtime_tokens JOIN cli_sessions … WHERE token_hash = sha256(bearer)
  AND revoked_at IS NULL AND expires_at > now() AND absolute_expires_at > now()` and the
  session isn't revoked. (This mirrors `verifyRuntimeBearer` exactly.)
- **Introspection endpoint (cleaner boundary).** Add a small `POST /api/v1/runtime-tokens/introspect`
  to the control plane that wraps `verifyRuntimeBearer` and returns `{ valid, orgId, userId }`;
  the gateway calls it per request (add a short in-memory cache to avoid a hop every call).
  *This endpoint doesn't exist yet — add it if you don't want to share the DB.*

Either way, **no RSA keypair and no JWT.** Revocation is immediate: logout / seat-loss / plan-end
all set `revoked_at`, and the next validation fails.

## 3. Configure the gateway (Railway)

| env var | value |
|---|---|
| `FOUNDRY_ENDPOINT` | the Target URI from §1 (e.g. `https://<resource>.services.ai.azure.com/models`) |
| `FOUNDRY_API_KEY` | the Foundry resource key |
| `FOUNDRY_API_VERSION` | e.g. `2024-05-01-preview` |
| `DATABASE_URL` | the shared Neon Postgres — used to **validate runtime tokens** (§2) *and* to report usage |
| `CONTROL_PLANE_URL` | `https://sanadcode.com` — only if you use the introspection option instead of the DB |
| `PORT` | Railway-provided |

The alias→deployment map lives in the gateway too. What the gateway sends to Foundry per
request (unified Model Inference pattern):

```
POST {FOUNDRY_ENDPOINT}/chat/completions?api-version={FOUNDRY_API_VERSION}
api-key: {FOUNDRY_API_KEY}
content-type: application/json

{ "model": "{deployment}",            // <- resolved from the alias
  "messages": [...],                   // passed through from the CLI
  "stream": true,
  "stream_options": { "include_usage": true } }   // <- required so metering gets token counts
```

For an Azure OpenAI-type deployment instead:
`POST {endpoint}/openai/deployments/{deployment}/chat/completions?api-version=…`
(same `api-key` header; **no** `model` in the body).

**The gateway does NOT enforce quota** — the control plane already does at mint/renew (§4).
After streaming completes, the gateway **reports usage** to the control plane:

```
POST https://sanadcode.com/api/v1/usage
Authorization: Bearer <the same runtime token>
{ "modelAlias": "<alias>", "tokensIn": <n>, "tokensOut": <n>, "eventId": "<idempotency key>" }
```

(That ingest endpoint is built — `app/api/v1/usage/route.ts` POST. Send a stable `eventId`
so retries don't double-bill.)

## 4. Configure the control plane (Vercel — `control-plane/artifacts/sanad-web`)

| env var | value |
|---|---|
| `GATEWAY_BASE_URL` | the deployed gateway origin + `/v1` (e.g. `https://sanad-gateway.up.railway.app/v1`) |
| `DATABASE_URL` | the shared Neon Postgres |
| `APP_URL` | `https://sanadcode.com` |
| Clerk keys | publishable + secret + webhook signing secret |
| Stripe keys | secret + webhook secret + the price IDs (billing) |

The runtime-token **mint response** the control plane returns — already implemented in
`lib/tokens/runtime.ts` + `lib/models/catalog.ts`, shown here for reference:

```jsonc
{
  "token": "<opaque runtime token 'rtok_…'; the control plane stores only its hash>",
  "tokenId": "...", "familyId": "...",
  "expiresAt": "<ISO ~10m>", "absoluteExpiresAt": "<ISO ~24h>",
  "gatewayBaseUrl": "https://<gateway-host>/v1",
  "modelSettings": [
    { "name": "kimi-k2.7-code",  "maxContextSize": 256000, "capabilities": ["thinking"] },
    { "name": "gpt-5.3-codex",   "maxContextSize": 200000, "capabilities": [] },
    { "name": "deepseek-v4-pro", "maxContextSize": 128000, "capabilities": ["thinking"] },
    { "name": "codestral",       "maxContextSize": 256000, "capabilities": [] },
    { "name": "mistral-small",   "maxContextSize": 128000, "capabilities": [] }
  ],
  "defaultModelAlias": "kimi-k2.7-code"
}
```

Entitlement (active plan / seat) **and** usage quota are both checked here at mint (and again
at renew): over quota → `402 quota_exceeded`, which the CLI surfaces and the renewer stops on.

## 5. Verify end-to-end

**Human check (fastest):**
```bash
sanad login                       # device flow against sanadcode.com
sanad run -p "reply with: ok"     # mints a runtime token, streams through Foundry
/model gpt-5.3-codex              # in-session model switch
sanad usage                       # confirm the request was metered
```

**Automated smoke (the gated live test):**
```bash
SANAD_SMOKE_API_BASE_URL=https://sanadcode.com \
SANAD_SMOKE_SESSION_TOKEN=<a session token from `sanad login`, read out-of-band from the keychain> \
  .venv/bin/python -m pytest tests/sanad/test_smoke.py -v
```
It mints a real runtime token, streams one real completion **through Foundry**, then revokes
the token family. Skipped unless both env vars are set.

## 6. Troubleshooting

| symptom | likely cause |
|---|---|
| CLI: `Authorization failed … session may have expired` on `run`/mid-session | the runtime token was revoked or expired; or the **gateway can't validate it** — confirm the gateway and control plane point at the **same `DATABASE_URL`** (or the same introspection endpoint) |
| Gateway → Foundry `404` (deployment not found) | wrong deployment name in the alias map, wrong `api-version`, or wrong endpoint pattern (Model Inference vs Azure OpenAI) |
| Gateway → Foundry `401` | wrong `FOUNDRY_API_KEY`, or the key lacks access to that deployment |
| CLI: `402 quota_exceeded` on `run` | the org hit its monthly allowance — working as designed (enforced at mint/renew); upgrade or wait for the period reset |
| `sanad usage` shows nothing | the gateway isn't POSTing to `/api/v1/usage`, or the Foundry request is missing `stream_options:{include_usage:true}` (the final chunk carries the token counts) |
| streaming stalls / buffers | the gateway must be a long-running process (Railway) **not** Vercel serverless; ensure it flushes each SSE frame |

## 7. Security invariants

- `FOUNDRY_API_KEY` lives **only** in the gateway env — never in the CLI, the control plane,
  or any client.
- Runtime tokens are opaque, high-entropy secrets **stored only as SHA-256 hashes**; they are
  short-lived (~10 min) + family-revocable, and logout / seat-loss / plan-end revoke them
  immediately.
- Quota + entitlement are enforced at the control plane (mint/renew); the gateway only proxies
  and reports usage.
- All hops are HTTPS; the CLI holds only the opaque *session* token (OS keychain) and, at
  runtime, the short-lived opaque *runtime* token — never an Azure credential.
