# sanad Gateway & Usage Metering — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use `- [ ]` checkboxes.
>
> **Where this runs:** TWO places. **(A)** small additions to the Next.js control-plane repo (plans #1/#2). **(B)** a **new, separate gateway service** — a long-running Node process on **Railway** (NOT Vercel; it streams). Implements **Spec #3** — `2026-08-03-sanad-gateway-usage-design.md`.

**Goal:** Be the only thing that talks to Azure AI Foundry: validate the runtime token, resolve the model alias to a deployment, enforce the org's quota, stream the completion back, and meter every call into `usage_events` — which backs the `sanad usage` command + dashboard widget.

**Architecture:** The control plane signs each runtime token as a **JWT** at mint. The gateway verifies it locally with the public key (stateless), checks quota against a per-org usage aggregate, proxies to Foundry with SSE passthrough, and writes one `usage_events` row per completed call. The control plane serves `GET /api/v1/usage` (already consumed by the shipped CLI).

**Tech Stack:** Gateway — Node + **Hono** (great streaming), `jose` (JWT), deployed on Railway. Control plane — Next.js + Drizzle/Neon + `jose`.

## Global Constraints
- **Runtime token = signed JWT.** Control plane signs with a private key (`RUNTIME_JWT_PRIVATE_KEY`); the gateway verifies with the public key (`RUNTIME_JWT_PUBLIC_KEY`). Claims: `{ sub:userId, org:orgId, sid:cliSessionId, fam:familyId, iat, exp }`, `exp` ≈ 10 min.
- **Alias→deployment map** is authoritative (from Spec #1): `gpt-5.3-codex`→`gpt-5.3-codex`, `kimi-k2.7-code`→`FW-Kimi-K2.7-Code`, `deepseek-v4-pro`→`DeepSeek-V4-Pro`, `codestral`→`Codestral-2501`, `mistral-small`→`mistral-small-2503`.
- The gateway is the **only writer** of `usage_events`; it never exposes Foundry creds to the CLI.
- **Hosting = Railway** (Node process, not Vercel). **Foundry auth = API key** in env (`FOUNDRY_ENDPOINT` + `FOUNDRY_API_KEY`). Revocation = short JWT TTL + a control-plane revocation-list the gateway checks (no Redis). Streaming-only.
- The CLI hits `POST {gatewayBaseUrl}/chat/completions` with `Authorization: Bearer <jwt>` and `{ model:<alias>, stream:true }` → OpenAI SSE back, terminated by `data: [DONE]`.
- `GET /api/v1/usage` (control plane, bearer session token) returns `{ used, limit, periodEnd, byModel:[{alias,requests,tokensIn,tokensOut}] }` — **shape frozen by the shipped CLI.**

## File Structure
```
# (A) control plane repo:
lib/tokens/runtime.ts        # sign JWT at mint (replace plan #1 opaque token)
lib/usage.ts                 # usageSummary(orgId) aggregate
app/api/v1/usage/route.ts    # GET /api/v1/usage (bearer)
# (B) gateway service repo (new):
src/index.ts                 # Hono app + /chat/completions + /health
src/auth.ts                  # verifyRuntimeJwt()
src/models.ts                # ALIAS_TO_DEPLOYMENT
src/quota.ts                 # checkQuota(orgId)
src/foundry.ts               # proxyStream() to Azure Foundry
src/meter.ts                 # recordUsage()
test/*.test.ts
```

---

### Task 1 (control plane): sign runtime tokens as JWTs

**Files:** Modify `lib/tokens/runtime.ts` (from plan #1 Task 7); Test `tests/unit/runtime-jwt.test.ts`

- [ ] **Step 1: Failing test** — `mintRuntime(session)` returns a `token` that `jose.jwtVerify` accepts with the public key and whose claims include `org`, `sid`, `fam`, and an `exp` ~10 min out.
- [ ] **Step 2: Run → fail. Step 3: Implement** — replace the opaque `token` with:

```ts
import { SignJWT, importPKCS8 } from "jose";
const key = await importPKCS8(process.env.RUNTIME_JWT_PRIVATE_KEY!, "RS256");
const token = await new SignJWT({ org: orgId, sid: cliSessionId, fam: familyId })
  .setProtectedHeader({ alg: "RS256" }).setSubject(userId)
  .setIssuedAt().setExpirationTime("10m").sign(key);
```

Keep the `runtime_tokens` row (for family revoke); the JWT `fam` maps to it.

- [ ] **Step 4: Run → pass. Commit:** `feat(tokens): sign runtime tokens as RS256 JWTs`.

### Task 2 (control plane): usage aggregate + `GET /api/v1/usage`

**Files:** Create `lib/usage.ts`, `app/api/v1/usage/route.ts`; Test `tests/contract/usage.test.ts`

- [ ] **Step 1: Failing contract test** — seed `usage_events` for an org + a session token; `GET /api/v1/usage` (bearer) returns `{ used, limit, periodEnd, byModel:[{alias,requests,tokensIn,tokensOut}] }` where `used` = sum of `byModel[].requests` and `limit` = the plan quota. This must match the shipped CLI's `UsageSummary`.
- [ ] **Step 2: Run → fail. Step 3: Implement** `usageSummary(orgId)` (Drizzle: group `usage_events` by `modelAlias` for the current period; join `subscriptions.quota` for `limit`) + the bearer-authed route.
- [ ] **Step 4: Run → pass. Commit:** `feat(usage): usage aggregate + GET /api/v1/usage`.

### Task 3 (gateway): scaffold + JWT verify

**Files:** Create gateway repo: `package.json`, `src/index.ts`, `src/auth.ts`, `src/models.ts`; Test `test/auth.test.ts`

- [ ] **Step 1:** `npm init` + `npm i hono @hono/node-server jose pg`. `src/index.ts` = Hono app with `GET /health`.
- [ ] **Step 2: Failing test** — `verifyRuntimeJwt(token)` returns `{ orgId, userId, sid, fam }` for a valid token and throws for expired/tampered.
- [ ] **Step 3: Run → fail. Step 4: Implement** `src/auth.ts` with `jose.jwtVerify(token, publicKey, { algorithms:["RS256"] })` → map claims; `src/models.ts` = `ALIAS_TO_DEPLOYMENT`.
- [ ] **Step 5: Run → pass. Commit:** `feat(gateway): scaffold + runtime-jwt verify`.

### Task 4 (gateway): quota check

**Files:** Create `src/quota.ts`; Test `test/quota.test.ts`

- [ ] **Step 1: Failing test** — with a seeded usage aggregate at/over the org's limit, `checkQuota(orgId)` returns `{ ok:false }`; under limit → `{ ok:true }`.
- [ ] **Step 2–4:** Implement `checkQuota` (query the same current-period aggregate as control-plane Task 2, against `subscriptions.quota`). Commit: `feat(gateway): per-org quota check`.

### Task 5 (gateway): Foundry SSE proxy + `/chat/completions`

**Files:** Create `src/foundry.ts`; Modify `src/index.ts`; Test `test/proxy.test.ts` (mock Foundry SSE server)

**Interfaces:** `POST /chat/completions` — auth (Task 3) → resolve alias → quota (Task 4) → stream.

- [ ] **Step 1: Failing test** — against a **mock Foundry** SSE endpoint, POST `/chat/completions` with a valid JWT + `{model:"kimi-k2.7-code",stream:true}` streams the chunks through unchanged and ends with `data: [DONE]`. Unknown alias → `400`; missing/invalid JWT → `401`; over quota → `429 {error:{code:"quota_exceeded"}}`.
- [ ] **Step 2: Run → fail. Step 3: Implement** the route:

```ts
app.post("/chat/completions", async (c) => {
  const claims = await verifyRuntimeJwt(bearer(c));           // 401 on throw
  const body = await c.req.json();
  const deployment = ALIAS_TO_DEPLOYMENT[body.model];
  if (!deployment) return c.json(err("unknown_model"), 400);
  if (!(await checkQuota(claims.orgId)).ok) return c.json(err("quota_exceeded"), 429);
  return streamSSE(c, async (stream) => {
    const usage = await proxyStream(deployment, body, stream);  // pipes Foundry SSE, captures usage
    await recordUsage(claims, body.model, usage);               // Task 6
  });
});
```

`proxyStream` calls Azure Foundry (`FOUNDRY_ENDPOINT` + deployment, creds from env; set `stream_options:{include_usage:true}`), forwarding each `data:` line and capturing the final `usage` block.

- [ ] **Step 4: Run → pass. Commit:** `feat(gateway): foundry SSE proxy + /chat/completions`.

### Task 6 (gateway): metering

**Files:** Create `src/meter.ts`; Test `test/meter.test.ts`

- [ ] **Step 1: Failing test** — `recordUsage(claims, "kimi-k2.7-code", {promptTokens:100, completionTokens:50})` inserts exactly one `usage_events` row (`orgId, userId, cliSessionId=sid, modelAlias, tokensIn=100, tokensOut=50, requests implied=1`).
- [ ] **Step 2–4:** Implement `recordUsage` (insert into `usage_events`). Commit: `feat(gateway): per-call usage metering`.

### Task 7: live E2E

- [ ] **Step 1:** Deploy the gateway to Railway; point `GATEWAY_BASE_URL` (control-plane env) at it. Run the CLI repo's gated `tests/sanad/test_smoke.py` with `SANAD_SMOKE_*` set → real mint (JWT) → streamed turn through Foundry → revoke. Assert a `usage_events` row appears and `sanad usage` reflects it. Commit: `test: live gateway smoke + metering`.

## Self-Review
- **Spec coverage:** §2 interface → Task 5; §3 lifecycle → 3,4,5,6; §4 JWT trust → 1,3; §5
  metering/quota + read API → 2,4,6; §7 testing → each task + 7. Family-revoke sub-TTL cache
  (spec §4/§8) is an **open item** carried forward, not yet a task — flagged here so it isn't
  silently dropped.
- **Placeholders:** `proxyStream`/`recordUsage`/`checkQuota`/`usageSummary` are named +
  specified; Foundry creds + JWT keys come from env.
- **Type consistency:** `verifyRuntimeJwt` claims (`orgId/userId/sid/fam`), `ALIAS_TO_DEPLOYMENT`,
  and the `usage_events` columns are used consistently across gateway + control-plane tasks.
