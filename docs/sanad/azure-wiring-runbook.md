# sanad — Azure Foundry Wiring Runbook

How to connect your Azure AI Foundry deployments to the `sanad` CLI **through**
`sanadcode.com` — the governed path where the CLI never holds an Azure key.

> Prereqs: the **control plane** (spec/plan #1, on Vercel) and the **gateway**
> (spec/plan #3, on Railway) are deployed, sharing one Postgres. The CLI is done
> and already defaults to `https://sanadcode.com`. This runbook is the glue that
> makes real models flow; the *code* lives in plan #1 and plan #3.

## 0. The trust chain (what you're wiring)

```
sanad CLI ──login──▶ control plane (Vercel)           ── issues ──▶ runtime token (RS256 JWT)
   │                     signs JWT with PRIVATE key
   └──run: POST {gatewayBaseUrl}/chat/completions  (Authorization: Bearer <JWT>, model=<alias>)
                          │
                          ▼
                   gateway (Railway)  ── verifies JWT with PUBLIC key
                          │            ── resolves alias → deployment
                          │            ── holds FOUNDRY_API_KEY
                          ▼
                   Azure AI Foundry  ── streams the completion back ──▶ metered → usage_events
```

Two secrets make it work: (a) an **RSA keypair** shared control-plane↔gateway so the
gateway trusts the CLI's token, and (b) the **Foundry API key**, which lives *only* in
the gateway.

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

**Alias → deployment map (locked):**

| alias (`/model <alias>`) | Azure Foundry deployment | default |
|---|---|---|
| `gpt-5.3-codex` | `gpt-5.3-codex` | |
| `kimi-k2.7-code` | `FW-Kimi-K2.7-Code` | ✓ |
| `deepseek-v4-pro` | `DeepSeek-V4-Pro` | |
| `codestral` | `Codestral-2501` | |
| `mistral-small` | `mistral-small-2503` | |

## 2. Generate the runtime-token keypair (one time)

```bash
# private key — goes to the CONTROL PLANE (it signs the runtime token)
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out runtime-jwt.pem
# public key — goes to the GATEWAY (it verifies the token)
openssl rsa -in runtime-jwt.pem -pubout -out runtime-jwt.pub
```

Set `RUNTIME_JWT_PRIVATE_KEY` = full contents of `runtime-jwt.pem` (control plane) and
`RUNTIME_JWT_PUBLIC_KEY` = full contents of `runtime-jwt.pub` (gateway). Store as
multiline secrets (or base64-encode and decode at boot). **The private key never leaves
the control plane; the public key never leaves the gateway.**

## 3. Configure the gateway (Railway)

| env var | value |
|---|---|
| `FOUNDRY_ENDPOINT` | the Target URI from step 1 (e.g. `https://<resource>.services.ai.azure.com/models`) |
| `FOUNDRY_API_KEY` | the Foundry resource key |
| `FOUNDRY_API_VERSION` | e.g. `2024-05-01-preview` |
| `RUNTIME_JWT_PUBLIC_KEY` | contents of `runtime-jwt.pub` |
| `DATABASE_URL` | the shared Neon Postgres (to write `usage_events`) |
| `PORT` | Railway-provided |

The alias→deployment map lives in the gateway (`src/models.ts`, plan #3). What the gateway
sends to Foundry per request (unified Model Inference pattern):

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

The gateway streams the Foundry SSE straight back to the CLI and, on the final `usage`
chunk, writes one `usage_events` row.

## 4. Configure the control plane (Vercel)

| env var | value |
|---|---|
| `RUNTIME_JWT_PRIVATE_KEY` | contents of `runtime-jwt.pem` |
| `GATEWAY_BASE_URL` | the deployed gateway origin + `/v1` (e.g. `https://sanad-gateway.up.railway.app/v1`) |
| `DATABASE_URL` | the shared Neon Postgres |
| `APP_URL` | `https://sanadcode.com` |
| Clerk keys | publishable + secret + webhook signing secret |

The runtime-token **mint response** the control plane returns (this is what the CLI reads
to register the models). Fill in each model's real context window + capabilities:

```jsonc
{
  "token": "<RS256 JWT, claims: {sub:userId, org:orgId, sid:cliSessionId, fam:familyId, exp:~10m}>",
  "tokenId": "...", "familyId": "...",
  "expiresAt": "<ISO ~10m>", "absoluteExpiresAt": "<ISO ~24h>",
  "gatewayBaseUrl": "https://<gateway-host>/v1",
  "modelSettings": [
    { "name": "kimi-k2.7-code",  "maxContextSize": <int>, "capabilities": ["thinking"] },
    { "name": "gpt-5.3-codex",   "maxContextSize": <int>, "capabilities": [] },
    { "name": "deepseek-v4-pro", "maxContextSize": <int>, "capabilities": ["thinking"] },
    { "name": "codestral",       "maxContextSize": <int>, "capabilities": [] },
    { "name": "mistral-small",   "maxContextSize": <int>, "capabilities": [] }
  ],
  "defaultModelAlias": "kimi-k2.7-code"
}
```

`capabilities` recognized by the CLI: only `thinking` maps through (`tool_use` is implicit).
Set the `["thinking"]` flags to what each deployment actually supports.

## 5. Verify end-to-end

**Human check (fastest):**
```bash
sanad login                       # device flow against sanadcode.com
sanad run -p "reply with: ok"     # mints a runtime token, streams through Foundry
# in-session, confirm switching:
/model gpt-5.3-codex
```
Success = a real streamed reply, and `sanad usage` shows the request counted.

**Automated smoke (the gated live test):**
```bash
SANAD_SMOKE_API_BASE_URL=https://sanadcode.com \
SANAD_SMOKE_SESSION_TOKEN=<a session token from `sanad login`, read out-of-band from the keychain> \
  .venv/bin/python -m pytest tests/sanad/test_smoke.py -v
```
It mints a real runtime token, streams one real completion **through Foundry**, then
revokes the token family. Skipped unless both env vars are set.

## 6. Troubleshooting

| symptom | likely cause |
|---|---|
| CLI: `Authorization failed … session may have expired` on `run` | JWT signature mismatch — the control plane's private key and the gateway's public key aren't a pair; or the runtime token expired (check the ~10m TTL + renewal) |
| Gateway → Foundry `404` (deployment not found) | wrong deployment name in the alias map, wrong `api-version`, or wrong endpoint pattern (Model Inference vs Azure OpenAI) |
| Gateway → Foundry `401` | wrong `FOUNDRY_API_KEY`, or the key lacks access to that deployment |
| CLI: `429 quota reached` | the org hit its free-tier quota — working as designed; check `subscriptions.quota` |
| `sanad usage` shows nothing | the Foundry request is missing `stream_options:{include_usage:true}` (the final chunk carries token counts) |
| streaming stalls / buffers | the gateway must be a long-running process (Railway) **not** Vercel serverless; ensure it flushes each SSE frame |

## 7. Security invariants

- `FOUNDRY_API_KEY` lives **only** in the gateway env — never in the CLI, the control
  plane, or any client.
- Runtime-token **private** key only in the control plane; **public** key only in the
  gateway.
- Runtime tokens are short-lived (~10 min) + family-revocable; rotate the Foundry key and
  the JWT keypair on a schedule.
- All hops are HTTPS; the CLI holds only the opaque *session* token (OS keychain) and, at
  runtime, the short-lived JWT — never an Azure credential.
