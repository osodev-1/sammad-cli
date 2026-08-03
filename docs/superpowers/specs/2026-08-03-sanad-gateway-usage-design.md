# sanad — LLM Gateway & Usage Metering (Design Spec)

**Status:** DRAFT for review · **Spec 3 of 4** · 2026-08-03
**Depends on:** Spec #1 (runtime-token shape, `usage_events` table, alias→deployment map).
**Runs where:** a **separate long-running service** (NOT Vercel) — streaming proxies need
persistent connections. Default target: a container on **Railway / Fly.io / Azure Container
Apps**.

> **Decisions (locked 2026-08-03):** runtime token = **signed JWT** (control plane signs,
> gateway verifies locally with the public key; revocation = short ~10-min TTL + a
> control-plane revocation-list the gateway checks — **no Redis**) · hosting = **Railway**
> (not Vercel) · Foundry auth = **API key** in env · cost model = request-quota (token counts
> + `cost` in micro-cents are reporting-only) · **streaming-only** · the gateway writes
> `usage_events` directly via a shared `DATABASE_URL`.

## 1. Purpose

Be the only thing that talks to Azure AI Foundry. Validate the runtime token the CLI presents,
resolve the model alias to a Foundry deployment, proxy the (OpenAI-compatible) chat completion
with streaming, **meter every call** into `usage_events`, and **enforce the org's quota**.

## 2. Interface (what the CLI sends)

The CLI configures an `openai_legacy` provider pointing at `gatewayBaseUrl` (from the mint
response) with the **runtime token** as the API key. So the gateway must expose:

```
POST {gatewayBaseUrl}/chat/completions
Authorization: Bearer <runtimeToken>
{ "model": "<alias>", "stream": true, "messages": [...] }
```

→ standard OpenAI streaming SSE (`data: {...}` chunks, terminated by `data: [DONE]`).

## 3. Request lifecycle

1. **Authenticate** the runtime token (JWT verify or DB introspection). Reject expired /
   revoked → `401`.
2. **Resolve** `model` (alias) → Foundry deployment via the map (Spec #1):
   `gpt-5.3-codex`→`gpt-5.3-codex`, `kimi-k2.7-code`→`FW-Kimi-K2.7-Code`,
   `deepseek-v4-pro`→`DeepSeek-V4-Pro`, `codestral`→`Codestral-2501`,
   `mistral-small`→`mistral-small-2503`. Unknown alias → `400`.
3. **Quota check:** read the org's current-period usage vs `subscriptions.quota`. Over →
   `429 { error: { code: "quota_exceeded", message: "...upgrade at sanadcode.com" } }`
   (the CLI already surfaces this).
4. **Proxy** to Azure Foundry (Foundry endpoint + deployment; the gateway holds the creds).
   Stream SSE straight back to the CLI.
5. **Meter on completion:** write a `usage_events` row (`orgId`, `userId`, `cliSessionId`,
   `modelAlias`, `tokensIn`, `tokensOut`, `cost`) from the Foundry `usage` block (request a
   final usage chunk / `stream_options: {include_usage:true}`), and increment the org's
   period counter.

## 4. Runtime-token trust (default = signed JWT)

- At mint (Spec #1 control plane), sign a JWT: `{ sub: userId, org: orgId, sid: cliSessionId,
  fam: familyId, exp, iat }` with a private key. `token` in the mint response = this JWT.
- The gateway verifies with the **public key** (shared via env/JWKS) — no DB round-trip.
- **Revocation** despite statelessness: short `exp` (~10 min, matching `expiresAt`); the CLI
  renews in place. Family revoke (Spec #1) additionally pushes revoked `fam`/`sid` ids to a
  small shared cache (Redis or a control-plane `revocations` endpoint the gateway polls) so a
  compromised token dies before its TTL.
- *(Alternative if JWT is unwanted: opaque token, `POST /introspect` to the control plane per
  request. Simpler, one network hop per call.)*

## 5. Metering & quota

- `usage_events` (defined in Spec #1) is written by the gateway — it is the **only** writer.
- A per-org current-period aggregate (materialized rollup or `SELECT sum(...)` with an index)
  backs both the quota check (step 3) and the Spec #1 dashboard widget / the `sanad usage`
  command.
- Quota window = subscription `currentPeriodEnd` (monthly). Reset implicitly by period.
- **CLI/dashboard read API:** the control plane serves `GET /api/v1/usage` (bearer session
  token) returning the current-period summary that the shipped `sanad usage` command and the
  dashboard widget render: `{ used, limit, periodEnd, byModel: [{ alias, requests, tokensIn,
  tokensOut }] }` (`used`/`limit` in requests; `used` = sum of `byModel[].requests`).

## 6. Config the gateway holds
- Azure Foundry endpoint + credentials (API key or managed identity).
- The alias→deployment map (shared with, or duplicated from, the control plane).
- The JWT public key (or the introspection URL).
- `DATABASE_URL` (to write `usage_events`) or a metering API on the control plane it POSTs to.

## 7. Testing
- Unit: alias resolution, JWT verify (valid/expired/revoked), quota decision.
- Integration: a **mock Foundry** SSE server → assert the gateway streams through unchanged
  and writes exactly one `usage_events` row with correct token counts.
- Live: the CLI repo's `tests/sanad/test_smoke.py` already mints → streams → revokes against a
  real gateway + Foundry; point it here.

## 8. Open questions
- Concurrency / rate limits per org at the gateway (tune under load).
