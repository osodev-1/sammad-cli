# Coder Panel P1b — Panel Spine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the browser Coder panel spine: a "Coder" tab in the workspace hosting one conversation against the P1a backend — streaming journal-driven transcript, inline Approval/Question cards answered via `/respond`, reconnect-safe turns, client-side queue — plus the three small backend items the P1a final review carried forward.

**Architecture:** `lib/coder/*` mirrors the architect client/transcript layering but speaks the coder contract (per-conversation routes, four extra journal kinds, double-wrapped JSON envelopes). `CoderPanel` adapts ArchitectPanel's proven machinery (phase machine, consume-fold, re-attach loop, sessionStorage anchor, outbox) with conversation lifecycle (mint ticket → create/open) and pending-request recovery from `GET /turn`. One singleton tab (`CODER_TAB_ID`), mounted-but-hidden; multi-conversation UI is P6.

**Tech Stack:** TypeScript/Next.js/React 19, inline `CSSProperties` styling with `var(--*)` tokens (NO tailwind/css-modules), vitest node-env (pure functions only — no component tests, no jsdom in this repo). Backend touch: Python/FastAPI (one hardening task). Spec: `docs/superpowers/specs/2026-08-12-coder-agent-panel-design.md`. Base: main @ 64b8e459 (P1a merged).

## Global Constraints

- **Commits are Omar-only** — `sanad: <description>`; NEVER any Co-Authored-By / AI attribution. BEFORE every commit: `git branch --show-current` must print `coder-panel-p1b` (Omar switches branches in other terminals; if different → STOP, report BLOCKED). System git shim is broken (Xcode license): prefix `PATH=/Library/Developer/CommandLineTools/usr/bin:$PATH` on every git command.
- **Working tree has Omar's dirty files** (`app/terminal/architect/ArchitectPanel.tsx`, `app/terminal/graph/GraphPanel.tsx`, `lib/architect/transcript.ts`, `tests/unit/architect-transcript.test.ts`, `.serena/`, a report md). NEVER touch or stage them. NEVER `git add -A`. NOTE: `lib/architect/client.ts` is CLEAN and Task 1 modifies it (import swap only).
- **Wire/journal contract (verified against merged P1a — do not re-derive):** journal items are `{seq, ...}` with turn-scoped dense seq; kinds `turn {turnId}`, `event {event:{type,payload}}`, `end {status}`, `error {code?,message}`, `request {requestType:"approval"|"question", requestId, turnId, request}`, `request_resolved {requestId, requestType, resolution}`, `request_cancelled {requestId, reason}`. Journal keys camelCase; nested `request`/`resolution` payloads snake_case. `GET .../turn` → `{turn: {turnId,status,userInput,lastSeq,startedAt(seconds)}|null, alive, pendingRequests:[{requestId,requestType,turnId,createdAt,request}]}`. ALL coder JSON routes arrive double-wrapped `{data:{...},meta}` via `relayJson` — always unwrap `body?.data ?? body`; NDJSON routes are raw.
- **Renderer semantics (P1a final-review carry-items, binding):** per-request journal items are LAST-WINS (`request_cancelled` then `request_resolved` can both land for one request — render the later item's state); `end` is NOT stream-terminal — keep consuming items until EOF (items like `request_cancelled` can trail `end`).
- **Error codes the client must handle:** 409 `busy` (carries `turnId`), 409 `not_started` / `turn_failed` (conversation was dropped — re-open with a FRESH ticket, retry once), 409 `conversation_limit`, 410 `request_gone` (card → expired state), 400 `invalid_response`, 403 `coder_not_enabled` vs `terminal_not_enabled` (distinct copy), 404 `unknown_turn`.
- **uiState schema:** `sessionUiState` has `v: z.literal(1)` + hard fallback to empty — every new field MUST be `.optional()` (precedent: `architect`, `dockOpen`).
- **Styling:** inline `CSSProperties` in a module-scope `const s`, achromatic `var(--*)` tokens, conditional styles via object spread. Buttons may use `button.*(size.*)` factories from `app/ui/theme.ts` (the tabs.tsx pattern) — do NOT invent new visual language.
- **Testing reality:** vitest is node-env, `.ts` glob only — React components are NOT unit-testable here. All logic must live in pure modules (`lib/coder/*`) with tests; components stay thin. Do not add jsdom/testing-library.
- Web commands run from `/Users/omar/Development/sammad-cli/control-plane/artifacts/sanad-web` (`pnpm test`, `pnpm exec tsc --noEmit`); backend from `/Users/omar/Development/sammad-cli/terminal-server` (`uv run pytest tests/ -q` — full suite is fast again, ~13s).

---

### Task 1: Extract `lib/ndjson.ts` (generic stream reader)

**Files:**
- Create: `control-plane/artifacts/sanad-web/lib/ndjson.ts`
- Modify: `control-plane/artifacts/sanad-web/lib/architect/client.ts` (delete the private `streamNdjson`, import the shared one)
- Test: existing `tests/unit/architect-client.test.ts` must pass UNCHANGED (it exercises `askArchitect`'s stream reassembly end-to-end — that is the gate)

**Interfaces:**
- Produces: `export async function streamNdjson<T>(res: Response, onItem: (item: T) => void): Promise<void>` — byte-for-byte the logic currently at `lib/architect/client.ts:68-101` (buffer across chunks, split on `\n`, skip unparsable lines, flush trailing buffer on EOF, `break` on read errors — caller re-follows). Generic `T` replaces `ArchitectItem`; the JSON.parse cast becomes `as T`.
- `lib/architect/client.ts` keeps its exact exported surface; internally `await streamNdjson<ArchitectItem>(res, onItem)`.

- [ ] **Step 1: Green baseline** — `cd /Users/omar/Development/sammad-cli/control-plane/artifacts/sanad-web && pnpm test tests/unit/architect-client.test.ts` → passes.
- [ ] **Step 2: Create `lib/ndjson.ts`** — move the function verbatim with the generic param and a doc comment stating it is the shared NDJSON reader for architect + coder streams. Delete the private copy from `lib/architect/client.ts`; add `import { streamNdjson } from "@/lib/ndjson";` and type the two call sites `streamNdjson<ArchitectItem>(...)`.
- [ ] **Step 3: Verify** — `pnpm test tests/unit/architect-client.test.ts && pnpm exec tsc --noEmit` → green, no new type errors.
- [ ] **Step 4: Commit** — `git add control-plane/artifacts/sanad-web/lib/ndjson.ts control-plane/artifacts/sanad-web/lib/architect/client.ts && git commit -m "sanad: extract shared NDJSON stream reader"`

---

### Task 2: `lib/coder/types.ts` + `lib/coder/client.ts`

**Files:**
- Create: `control-plane/artifacts/sanad-web/lib/coder/types.ts`, `control-plane/artifacts/sanad-web/lib/coder/client.ts`
- Create: `control-plane/artifacts/sanad-web/tests/unit/coder-client.test.ts`

**Interfaces (Tasks 3/5/6 consume — exact):**

`types.ts`:

```ts
/** One item off a coder turn stream / journal (mirrors routes_coder + coder_runner). */
export type CoderItem =
  | { kind: "turn"; seq?: number; turnId: string }
  | { kind: "event"; seq?: number; event: { type?: string; payload?: Record<string, unknown> } }
  | { kind: "end"; seq?: number; status?: string }
  | { kind: "error"; seq?: number; code?: string; message?: string; turnId?: string }
  | { kind: "request"; seq?: number; requestType: "approval" | "question"; requestId: string; turnId: string; request: Record<string, unknown> }
  | { kind: "request_resolved"; seq?: number; requestId: string; requestType: "approval" | "question"; resolution: Record<string, unknown> }
  | { kind: "request_cancelled"; seq?: number; requestId: string; reason?: string };

export interface CoderTurnSummary {
  turnId: string;
  status: "running" | "finished" | "cancelled" | "failed";
  userInput: string; // truncated to 200 chars server-side
  lastSeq: number;
  startedAt: number; // UNIX SECONDS
}

export interface PendingRequestSummary {
  requestId: string;
  requestType: "approval" | "question";
  turnId: string;
  createdAt: number;
  request: Record<string, unknown>;
}

export interface CoderTurnState {
  turn: CoderTurnSummary | null;
  alive: boolean;
  pendingRequests: PendingRequestSummary[];
}

/** Approval payload fields the card renders (wire snake_case). */
export interface ApprovalPayload {
  id: string; tool_call_id?: string; sender?: string; action?: string;
  description?: string; source_kind?: string | null; subagent_type?: string | null;
  display?: unknown[];
}
export interface QuestionOptionPayload { label: string; description?: string }
export interface QuestionItemPayload {
  question: string; header?: string; options: QuestionOptionPayload[];
  multi_select?: boolean; body?: string; other_label?: string; other_description?: string;
}
export interface QuestionPayload { id: string; questions: QuestionItemPayload[] }

export type RespondPayload =
  | { response: "approve" | "approve_for_session" | "reject"; feedback?: string }
  | { answers: Record<string, string> };
```

`client.ts` exports (all take `sessionId?: string` last unless noted; all coder JSON responses unwrap `body?.data ?? body`; every path built with `withSession` from `@/lib/terminal/workspace-model`):

```ts
export interface EnsureResult { ok: boolean; conversationId?: string; error?: string; errorCode?: string }
/** Mint a terminal ticket (also wakes the machine), then open the existing
 * conversation or create a new one. Mirrors startArchitect's two-step. */
export async function ensureConversation(existingId: string | undefined, sessionId?: string): Promise<EnsureResult>;
export async function sendCoder(cid: string, input: string, sendId: string | undefined, sessionId: string | undefined, onItem: (i: CoderItem) => void, signal?: AbortSignal): Promise<void>;
export async function followCoder(cid: string, turnId: string, fromSeq: number, sessionId: string | undefined, onItem: (i: CoderItem) => void): Promise<void>;
export async function fetchCoderTurn(cid: string, sessionId?: string): Promise<CoderTurnState | null>;
export async function respondCoder(cid: string, requestId: string, payload: RespondPayload, sessionId?: string): Promise<{ ok: boolean; code?: string; message?: string }>;
export async function cancelCoder(cid: string, sessionId?: string): Promise<void>;
export async function stopCoder(cid: string, sessionId?: string): Promise<void>;
/** Envelope-tolerant extractors (coder-typed twins of the architect helpers). */
export function textFromEvent(item: CoderItem): string | null;
export function thinkFromEvent(item: CoderItem): string | null;
export function toolLabel(item: CoderItem): string | null;
```

Implementation requirements (grounded in the verified contract):
- `ensureConversation`: `POST /api/terminal/session` `{sessionId}` → `parseSessionGrant` (from `@/lib/terminal/protocol`) → if `existingId`: `POST withSession(\`/api/coder/conversations/${encodeURIComponent(existingId)}/open\`, sessionId)` `{ticket}`; on 400 `invalid_conversation` OR any 404, fall through to create. Create: `POST withSession("/api/coder/conversations", sessionId)` `{ticket}` → unwrap → `{conversationId}`. Map failures to `{ok:false, error, errorCode}` — importantly `coder_not_enabled` ("The coding agent is not enabled for this account.") vs `terminal_not_enabled` vs `conversation_limit` distinct messages. NOTE: open and create each need their OWN minted ticket (tickets are one-time); mint once, and if open falls through to create, mint AGAIN before create.
- `sendCoder`/`followCoder`: clone ask/follow from the architect client (error envelope → synthesized `{kind:"error", code, turnId?, message}` item incl. the `busy` code carrying `b?.error?.turnId`), using `streamNdjson<CoderItem>`. Send body `{input, sendId}`.
- `fetchCoderTurn`: unwrap and default `pendingRequests` to `[]`.
- `respondCoder`: POST `{requestId, ...payload}`; 200 → `{ok:true}`; else `{ok:false, code: b?.error?.code, message}` (never throws).
- `toolLabel` map (coder toolset): `Shell: "Running a command"`, `WriteFile: "Writing a file"`, `StrReplaceFile: "Editing a file"`, `ReadFile: "Reading files"`, `Grep: "Searching files"`, `Glob: "Finding files"`, `ReadMediaFile: "Reading media"`, `SearchWeb: "Searching the web"`, `FetchURL: "Fetching a page"`, `SetTodoList: "Updating the plan"`, `AskUserQuestion: "Asking you a question"`, `EnterPlanMode: "Entering plan mode"`, `ExitPlanMode: "Proposing a plan"`, `Agent: "Delegating to a subagent"`, `TaskList: "Checking background tasks"`, `TaskOutput: "Reading task output"`, `TaskStop: "Stopping a task"`; fallback `` `Running ${name}` `` / `"Working"`.

- [ ] **Step 1: Write failing tests** — `tests/unit/coder-client.test.ts`, following `tests/unit/architect-client.test.ts`'s established pattern (`vi.stubGlobal("fetch", ...)` with hand-built `ReadableStream` responses). Cases (write them concretely):
  1. `sendCoder` reassembles NDJSON across chunk boundaries and surfaces `request` + `request_resolved` items in order (feed a stream containing: turn, event TextPart, request approval, request_resolved, end — split mid-line across two chunks; assert the onItem sequence).
  2. `sendCoder` non-2xx with `{error:{code:"busy",turnId:"t_1"}}` → exactly one `{kind:"error",code:"busy",turnId:"t_1"}` item.
  3. `fetchCoderTurn` unwraps the double envelope `{data:{turn,alive,pendingRequests}}` AND tolerates the bare shape; missing `pendingRequests` → `[]`.
  4. `ensureConversation` happy-create: fetch mock sequence mint→create; asserts create body carries the minted ticket and result carries `conversationId`.
  5. `ensureConversation` open-falls-through-to-create: open returns 400 `invalid_conversation` → a SECOND mint happens → create succeeds (assert two mint calls — one-time tickets).
  6. `ensureConversation` surfaces `coder_not_enabled` distinctly (`errorCode === "coder_not_enabled"`).
  7. `respondCoder` maps 410 to `{ok:false, code:"request_gone"}`.
  8. `toolLabel`/`textFromEvent`/`thinkFromEvent` behave on coder-shaped events (Shell → "Running a command"; think requires `payload.type === "think"`).
- [ ] **Step 2: RED** — `pnpm test tests/unit/coder-client.test.ts` fails (module missing).
- [ ] **Step 3: Implement** `types.ts` + `client.ts` per the interfaces above.
- [ ] **Step 4: GREEN** — focused test passes; `pnpm exec tsc --noEmit` clean.
- [ ] **Step 5: Commit** — `git add control-plane/artifacts/sanad-web/lib/coder/types.ts control-plane/artifacts/sanad-web/lib/coder/client.ts control-plane/artifacts/sanad-web/tests/unit/coder-client.test.ts && git commit -m "sanad: coder client — conversation lifecycle, NDJSON turns, respond"`

---

### Task 3: `lib/coder/transcript.ts` (blocks, fold, persistence)

**Files:**
- Create: `control-plane/artifacts/sanad-web/lib/coder/transcript.ts`
- Create: `control-plane/artifacts/sanad-web/tests/unit/coder-transcript.test.ts`

**Interfaces (Tasks 5/6 consume — exact):**

```ts
import type { CoderItem, ApprovalPayload, QuestionPayload } from "./types";

export type RequestState = "pending" | "resolved" | "cancelled";
export type CoderBlock =
  | { kind: "text"; text: string }
  | { kind: "think"; text: string }                        // never persisted
  | { kind: "tool"; label: string }
  | { kind: "request"; requestId: string; requestType: "approval" | "question";
      payload: ApprovalPayload | QuestionPayload; state: RequestState;
      resolution?: Record<string, unknown> };
export type CoderMessage =
  | { role: "user"; text: string; at?: number }
  | { role: "assistant"; blocks: CoderBlock[]; at?: number };

/** Fold one journal item into an assistant message's blocks. Pure. */
export function reduce(blocks: CoderBlock[], item: CoderItem): CoderBlock[];

/** Serialize for uiState (caps mirror the architect: 60 msgs / 80 blocks /
 * 6000 chars; think dropped; ⚠ lines dropped; PENDING requests downgraded to
 * "cancelled" — a restored card must never look answerable). */
export function toStored(messages: CoderMessage[]): StoredCoderMessage[];
export function fromStored(stored: StoredCoderMessage[]): CoderMessage[];
/** Local structural types — Task 4's zod schema in lib/sessions/state.ts MUST
 * match these shapes exactly (TS structural typing keeps them assignable). */
export type StoredCoderBlock =
  | { kind: "text"; text: string }
  | { kind: "tool"; label: string }
  | { kind: "request"; requestId: string; requestType: "approval" | "question";
      summary: string; state: "resolved" | "cancelled"; outcome?: string };
export type StoredCoderMessage =
  | { role: "user"; text: string; at?: number }
  | { role: "assistant"; blocks: StoredCoderBlock[]; at?: number };
```
`toStored` maps a request block → `{kind:"request", requestId, requestType, summary, state, outcome}` where `summary` = approval `action` + `description` (first 300 chars) or the first question text; `outcome` = approval `resolution.response` or a comma-joined answers digest; PENDING → stored as `"cancelled"`. `fromStored` rehydrates request blocks as inert (no `payload`) — cards render `summary`/`outcome` read-only.

`reduce` semantics (order: think → text → tool → request lifecycle → error; grounded in the architect fold you may read at `ArchitectPanel.tsx:27-79`):
- think/text coalesce into a trailing block of the same kind; consecutive identical tool labels dedupe (verbatim architect behavior, via the Task 2 extractors).
- `kind === "request"` → append `{kind:"request", requestId, requestType, payload: item.request as ..., state:"pending"}`. If a block with the same `requestId` already exists (journal replay), REPLACE it in place preserving order instead of appending a duplicate.
- `kind === "request_resolved"` → find the block by `requestId` and return a copy with `state:"resolved", resolution: item.resolution`. Unknown id → append nothing, return blocks unchanged. **LAST-WINS: this transition applies even if the block is currently "cancelled"** (see Global Constraints).
- `kind === "request_cancelled"` → same lookup → `state:"cancelled"` — but ONLY if current state is `"pending"` (never demote a resolved block; last-wins means resolved-after-cancelled upgrades, cancelled-after-resolved is ignored).
- `kind === "error"` with `code !== "busy"` → append `{kind:"text", text: \`⚠ ${message}\`}` (architect behavior).
- `RequestOutcome` events are NOT rendered (the request block already shows the resolution) — the extractors return null for them naturally; assert that in tests.

- [ ] **Step 1: Failing tests** — cases: request lifecycle pending→resolved (block replaced in place, order stable); pending→cancelled; cancelled→resolved (LAST-WINS upgrade); resolved→cancelled attempt (ignored); duplicate `request` item replay (no duplicate block); items after `end` still fold (feed request_cancelled after end through a sequence and assert state); think/text coalescing + tool dedupe; toStored drops think/⚠ and downgrades pending→cancelled; fromStored round-trip; caps (61 messages → 60; 6001-char text truncated).
- [ ] **Step 2: RED** — module missing.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: GREEN** + tsc clean.
- [ ] **Step 5: Commit** — `git add control-plane/artifacts/sanad-web/lib/coder/transcript.ts control-plane/artifacts/sanad-web/tests/unit/coder-transcript.test.ts && git commit -m "sanad: coder transcript — journal fold with request lifecycle, last-wins"`

---

### Task 4: uiState `coder` slot + server-side gate flag

**Files:**
- Modify: `control-plane/artifacts/sanad-web/lib/sessions/state.ts`
- Modify: `control-plane/artifacts/sanad-web/tests/unit/session-state.test.ts` (append)
- Modify: `control-plane/artifacts/sanad-web/app/terminal/page.tsx` + the component chain to `SessionWorkspace` (thread `coderEnabled: boolean`)

**Interfaces:**
- `sessionUiState` gains (ALL optional — `v: z.literal(1)` constraint):

```ts
export const coderBlockState = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string().max(6000) }),
  z.object({ kind: z.literal("tool"), label: z.string().max(200) }),
  z.object({
    kind: z.literal("request"),
    requestId: z.string().max(128),
    requestType: z.enum(["approval", "question"]),
    summary: z.string().max(300),           // action/question one-liner for display
    state: z.enum(["resolved", "cancelled"]), // pending is never persisted
    outcome: z.string().max(200).optional(),  // "approve" | "reject" | answers digest
  }),
]);
export const coderMessageState = z.union([
  z.object({ role: z.literal("user"), text: z.string().max(8000), at: z.number().optional() }),
  z.object({ role: z.literal("assistant"), blocks: z.array(coderBlockState).max(80), at: z.number().optional() }),
]);
export type StoredCoderMessage = z.infer<typeof coderMessageState>;
// on sessionUiState:
coder: z.object({
  conversationId: z.string().max(64).optional(),
  transcript: z.array(coderMessageState).max(60).optional(),
}).optional(),
```

(Alignment: this zod schema must match Task 3's local `StoredCoderBlock`/`StoredCoderMessage` shapes EXACTLY — structural typing is the compatibility contract; Task 3's test suite already locks the TS side.)

- `page.tsx`: alongside the existing terminal-allowlist gate, compute `const coderEnabled = isCoderPanelAllowed(email)` (import from `@/lib/auth/coder`) and thread it as a prop through the whole chain: `page.tsx` → `WorkspaceClient` → `SessionWorkspace` (read `page.tsx` + `WorkspaceClient.tsx` first; add `coderEnabled?: boolean` with a `false` default at each hop, INCLUDING SessionWorkspace's props signature — it stays unconsumed until Task 7, which is fine for a destructured optional prop).

- [ ] **Step 1: Failing tests** — append to `session-state.test.ts`: a blob with a `coder` slot parses and round-trips; a blob WITHOUT it still parses (back-compat); a `coder.transcript` entry with `state:"pending"` fails validation (enum excludes it) causing the WHOLE blob to degrade to empty via `parseSessionState` — assert that explicitly so the never-persist-pending invariant is enforced at the schema level.
- [ ] **Step 2: RED.** — new tests fail (schema missing).
- [ ] **Step 3: Implement** schema + prop threading.
- [ ] **Step 4: GREEN** — `pnpm test tests/unit/session-state.test.ts` + `pnpm exec tsc --noEmit`.
- [ ] **Step 5: Commit** — `git add control-plane/artifacts/sanad-web/lib/sessions/state.ts control-plane/artifacts/sanad-web/tests/unit/session-state.test.ts control-plane/artifacts/sanad-web/app/terminal/page.tsx control-plane/artifacts/sanad-web/app/terminal/WorkspaceClient.tsx && git commit -m "sanad: coder uiState slot + server-computed coder gate flag"` (adjust the staged list if the prop chain touches a different intermediate file — stage exactly the files you changed, nothing else).

---

### Task 5: `RequestCards.tsx` — Approval + Question cards

**Files:**
- Create: `control-plane/artifacts/sanad-web/app/terminal/coder/RequestCards.tsx`

**Interfaces (Task 6 consumes):**

```tsx
export function ApprovalCard(props: {
  block: Extract<CoderBlock, { kind: "request" }>;
  busy: boolean;                                  // a respond POST is in flight
  onRespond: (payload: RespondPayload) => void;   // approve / approve_for_session / reject+feedback
}): JSX.Element;

export function QuestionCard(props: {
  block: Extract<CoderBlock, { kind: "request" }>;
  busy: boolean;
  onRespond: (payload: RespondPayload) => void;   // { answers }
}): JSX.Element;
```

Behavior (components stay logic-thin; all state is local UI state):
- **ApprovalCard, pending:** header row `Approval needed` (mono eyebrow style) + `action`; `description` in a mono block (pre-wrap, max-height ~10rem with overflow auto); a `source chip` when `source_kind === "background_agent"` or `subagent_type` present (`via <subagent_type>`). Buttons (theme factories): `button.primary(size.sm)` **Allow**; `button.secondary(size.sm)` **Allow for session**; `button.secondary(size.sm)` **Deny**; quiet toggle **Deny with feedback…** revealing a textarea + confirm that calls `onRespond({response:"reject", feedback})`. All buttons disabled when `busy`.
- **ApprovalCard, resolved:** collapse to one row — `✓ Allowed` / `✓ Allowed for session` / `✗ Denied` (+ ` — "${feedback}"` when present), derived from `block.resolution.response`/`.feedback`.
- **ApprovalCard, cancelled:** one muted row `Expired — the turn ended before you answered` (also used for stored/rehydrated cards, which render `summary`/`outcome` when `payload` is absent).
- **QuestionCard, pending:** for each of 1–4 questions: `header` chip + `question` text + optional `body`; options as buttons (single-select: click = select; multi_select: toggle checkboxes); a synthetic **Other** option (label `other_label || "Other"`) revealing a free-text input. Submit button enabled when every question has an answer; builds `answers = { [question]: label }` (multi-select comma-joined; Other → the typed text) → `onRespond({answers})`.
- **QuestionCard resolved/cancelled:** collapsed row (`Answered: <digest>` / `Expired`).
- Styling: module-scope `const s`, achromatic tokens, spread-conditional. No new global CSS.

- [ ] **Step 1: Implement** both cards. No unit tests (components are untestable in this repo — the request-state logic they render is already covered by Task 3's reducer tests; keep ALL decision logic out of these components).
- [ ] **Step 2: Verify** — `pnpm exec tsc --noEmit` clean (this is the only automated gate for this task; visual verification happens in Task 7's smoke).
- [ ] **Step 3: Commit** — `git add control-plane/artifacts/sanad-web/app/terminal/coder/RequestCards.tsx && git commit -m "sanad: coder approval and question cards"`

---

### Task 6: `CoderPanel.tsx`

**Files:**
- Create: `control-plane/artifacts/sanad-web/app/terminal/coder/CoderPanel.tsx`

**Reference implementation:** `app/terminal/architect/ArchitectPanel.tsx` — READ IT FIRST; this task adapts its exact machinery. Cite-by-structure below uses its line numbers.

**Interfaces (Task 7 consumes):**

```tsx
export default function CoderPanel(props: {
  sessionId?: string;
  visible: boolean;
  conversationId?: string;                          // persisted; undefined until first ensure
  onConversationId?: (cid: string) => void;         // persist upward
  initial?: StoredCoderMessage[];
  onPersist?: (messages: StoredCoderMessage[]) => void;
}): JSX.Element | null;
```

Structure — each bullet names the ArchitectPanel mechanism to adapt and the coder delta:

1. **Phase machine** (`"idle"|"starting"|"ready"|"streaming"|"busy"|"error"`, AP:118) — unchanged.
2. **begin()** (AP:203-214) → `ensureConversation(conversationId, sessionId)`; on ok: `onConversationId?.(cid)`, keep `cid` in a ref + state; then `fetchCoderTurn(cid)`: if `turn?.status === "running"` → resume via `runTurn(turn.userInput || "(earlier request)", true, undefined, {turnId, at: startedAt*1000})`; else if `pendingRequests.length > 0` → append an assistant message whose blocks are those pending requests folded via `reduce` (so reload shows answerable cards) and set phase `"ready"`. Start on first reveal (AP:218-223 effect).
3. **runTurn + consume** (AP:258-446) — adapt with: `sendCoder`/`followCoder`; anchor key `` `sanad-coder-turn:${sessionId ?? "default"}` ``; the consume fold calls Task 3's `reduce` (which handles the four request kinds); dedupe by seq, saveAnchor, activity line (think→"Thinking", label, text→"Writing"), `end` sets `flags.ended` BUT DO NOT stop consuming (the stream is drained to EOF by streamNdjson — later `request_cancelled` items must still fold; this is the architect's existing behavior, preserve it); re-attach loop **`attempts < 90` → keep, but on `not_started`/`turn_failed` error items: `flags.failed = true; flags.ended = true`** (conversation was DROPPED server-side — the re-open lives in the failed branch, which calls `begin()` then requeues with `retry:true`, mirroring AP:412-415; `begin` re-mints a ticket and re-opens the conversation id, falling through to create if the id is gone).
4. **Busy branch** (AP:387-411) — same rollback + front-requeue + `fetchCoderTurn` resume (note `startedAt*1000`).
5. **Outbox** (AP:129, 482-497, 806-856) — clone: editable/removable queued bubbles, drain on ready.
6. **Respond wiring (new):** `respond(block, payload)` → set `respondBusy[requestId]=true` → `respondCoder(cid, requestId, payload)`; on `{ok:false, code:"request_gone"}` fold a synthetic `{kind:"request_cancelled", requestId}` through `reduce` so the card flips to Expired; on other failures show the message as a `⚠` text block; ALWAYS clear busy. The success path needs NO local fold — the journaled `request_resolved` arrives on the live stream and folds naturally. EXCEPTION: when phase is NOT `"streaming"` (answering a pending card after reload with no live follower), optimistically fold `{kind:"request_resolved", requestId, requestType, resolution: payloadAsResolution}` locally after a 200.
7. **Persistence** — on turn boundaries (where AP calls `onPersist`) call `onPersist?.(toStored(messages))`; hydrate from `initial` via `fromStored` (AP's `restoredCount` divider pattern).
8. **Status strip + stall watchdog + stop** (AP:81-82, 535-541, 859-882) — clone; `stopTurn` → `cancelCoder(cid)`. Add to the strip, when any pending request exists and phase is `"streaming"`: `Waiting on your approval…` (takes precedence over the activity label).
9. **Composer** (AP:884-913) — clone; placeholder "Ask the coder…"; `Queue` label while streaming/busy.
10. **Error phase** — distinct copy for `errorCode === "coder_not_enabled"` ("The coding agent isn't enabled for this account.") vs generic; "Try again" button re-runs begin (AP:653-666 pattern).
11. **Transcript rendering** — AP:675-804 structure: day separators, user bubbles, assistant blocks switching on kind: `think` (behind the `showSteps` toggle), `text`, `tool` (dot row), `request` → `<ApprovalCard/>`/`<QuestionCard/>` with `busy={!!respondBusy[requestId]}` and `onRespond`.
12. `if (!visible) return null;` (AP:623) + module-scope `const s` styles — start from AP's `s` and trim to what's used; request-card styles live in RequestCards.tsx.

- [ ] **Step 1: Implement** per the structure map. While adapting, keep every AP resilience behavior you copy IDENTICAL unless a delta above says otherwise — the review will diff your deviations against this list.
- [ ] **Step 2: Verify** — `pnpm exec tsc --noEmit` clean; `pnpm test` full suite still green (no component tests exist — the gate is compilation + the lib tests).
- [ ] **Step 3: Commit** — `git add control-plane/artifacts/sanad-web/app/terminal/coder/CoderPanel.tsx && git commit -m "sanad: CoderPanel — conversation lifecycle, journal transcript, inline approvals"`

---

### Task 7: Tab + SessionWorkspace integration

**Files:**
- Modify: `control-plane/artifacts/sanad-web/app/terminal/tabs.tsx` (export `CODER_TAB_ID = "coder"`; `TabsBar` gains `showCoder: boolean` + `onOpenCoder: () => void`, renders a `Coder` tab after the Blueprint tab — icon: reuse an existing suitable icon from `app/ui/icons.tsx` (e.g. a terminal/code glyph); only add a new icon if nothing fits, following the file's stroke conventions; no close button, active when `active === CODER_TAB_ID`)
- Modify: `control-plane/artifacts/sanad-web/app/terminal/SessionWorkspace.tsx`:
  - accept `coderEnabled?: boolean` (threaded from Task 4)
  - `const coderActive = active === CODER_TAB_ID;`
  - mounted-but-hidden pane next to the graph pane: `<div style={coderActive ? s.coderPane : s.paneHidden}>` with `coderPane` cloned from `graphPane` (absolute inset, column flex); inside: `<CoderPanel sessionId={sessionId} visible={coderActive} conversationId={coderConvId} onConversationId={setCoderConvId} initial={coderTranscript} onPersist={setCoderTranscript} />`. Render the pane ONLY when `coderEnabled` (feature dark for everyone else).
  - state `coderConvId` / `coderTranscript` hydrated from `uiState.coder` (hydrate effect ~line 110-165) and persisted in the debounced persist effect (~line 232-258) as `coder: { conversationId: coderConvId, transcript: coderTranscript }` (omit the key when both empty).
  - stale-`active` guard (~461-468): add `CODER_TAB_ID` to the allowed ids (only when `coderEnabled`).
  - pass `showCoder={coderEnabled ?? false}` + `onOpenCoder={() => setActive(CODER_TAB_ID)}` to `TabsBar`.
- Test: `pnpm test` (full) + `pnpm exec tsc --noEmit`.

- [ ] **Step 1: Implement** tabs.tsx additions, then SessionWorkspace wiring per the list.
- [ ] **Step 2: Verify** — tsc clean; full web suite green; `pnpm build` (or `pnpm exec next build` — check package.json scripts) compiles the new page graph without errors.
- [ ] **Step 3: Manual smoke note** — write into your report the exact manual QA script for Omar (cannot be automated here): set `SANAD_CODER_PANEL_EMAILS` + backend `CODER_ENABLED=1`, open /terminal, Coder tab appears, send "run ls" → approval card → Allow → output streams; reload mid-approval → card still answerable; deny with feedback → agent adjusts.
- [ ] **Step 4: Commit** — `git add control-plane/artifacts/sanad-web/app/terminal/tabs.tsx control-plane/artifacts/sanad-web/app/terminal/SessionWorkspace.tsx && git commit -m "sanad: Coder tab — gated singleton pane hosting the coder panel"`

---

### Task 8: Backend carry-items from the P1a final review

**Files:**
- Modify: `terminal-server/src/sanad_terminal/coder_runner.py` (journal-before-register in `on_request`)
- Modify: `terminal-server/tests/test_wire_runner.py` (no-turn reject test)
- Modify: `terminal-server/tests/test_routes_coder.py` (open-at-cap test)

**Interfaces:** behavior-preserving hardening; no API change.

- [ ] **Step 1: Failing/locking tests.**
  (a) `test_wire_runner.py` — the no-turn reject branch (currently only code-inspected):

```python
@pytest.mark.asyncio
async def test_request_with_no_running_turn_is_rejected(tmp_path):
    """Bridged types still reject when no turn is running (background lane = P3/P4)."""
    runner = CoderRunner(
        conversation_id=new_conversation_id(),
        argv=(sys.executable, str(FAKE_WIRE)),
        cwd=tmp_path,
        env={},
        max_turn_seconds=3600.0,
        max_steps_per_turn=200,
    )
    await runner.start()
    try:
        handled = await runner.on_request(
            "req_ghost",
            {"type": "ApprovalRequest", "payload": {"id": "req_ghost", "action": "run command"}},
        )
        assert handled is False
        assert runner.pending_summaries() == []
    finally:
        await runner.stop()
```

  (b) `test_routes_coder.py` — open-at-cap (uses the existing `client` fixture with `coder_max_conversations=2`):

```python
def test_open_existing_id_also_hits_the_cap(client: TestClient):
    """`open` consumes a live-process slot exactly like create (controller ruling, P1a)."""
    cids = [
        client.post(
            "/internal/coder/conversations", headers=HEADERS, json={"ticket": "tt_good"}
        ).json()["conversationId"]
        for _ in range(2)
    ]
    stopped = cids[0]
    assert (
        client.post(
            f"/internal/coder/conversations/{stopped}/stop", headers=HEADERS
        ).status_code
        == 200
    )
    third = client.post(
        "/internal/coder/conversations", headers=HEADERS, json={"ticket": "tt_good"}
    )
    assert third.status_code == 200  # slot freed by stop
    reopen = client.post(
        f"/internal/coder/conversations/{stopped}/open",
        headers=HEADERS,
        json={"ticket": "tt_good"},
    )
    assert reopen.status_code == 409
    assert reopen.json()["error"]["code"] == "conversation_limit"
```

- [ ] **Step 2: Run both** — (a) should PASS already (locks the branch in); (b) should PASS already (locks the ruling in). If either FAILS, the behavior differs from the review's reading — STOP and report the actual behavior instead of forcing the assertion.
- [ ] **Step 3: Journal-before-register hardening** — in `coder_runner.py`'s `on_request`, move the `self._pending_requests[rid] = PendingRequest(...)` assignment to AFTER the `await self._append(...)` call (so a failed append can't leave a ghost pending entry the journal never saw). Preserve all existing behavior otherwise.
- [ ] **Step 4: Full backend suite** — `cd /Users/omar/Development/sammad-cli/terminal-server && uv run pytest tests/ -q` → all pass (~13s).
- [ ] **Step 5: Commit** — `git add terminal-server/src/sanad_terminal/coder_runner.py terminal-server/tests/test_wire_runner.py terminal-server/tests/test_routes_coder.py && git commit -m "sanad: bridge hardening — journal-before-register, no-turn and open-at-cap tests"`

---

## P1b exit criteria

| Item | Where |
|---|---|
| Shared NDJSON reader, architect untouched behaviorally | Task 1 |
| Coder client: lifecycle (mint→open/create with re-mint), streams, respond, distinct gate errors | Task 2 |
| Journal-driven fold incl. request lifecycle, LAST-WINS, post-`end` items | Task 3 |
| uiState slot (optional, pending-never-persisted enforced at schema) + server gate flag | Task 4 |
| Inline Approval + Question cards (allow/allow-session/deny+feedback; multi-select+Other) | Task 5 |
| CoderPanel: begin→ensure→resume/pending-recovery, runTurn re-attach, outbox, respond wiring, stall/stop | Task 6 |
| Gated Coder tab, mounted-hidden pane, persistence wiring | Task 7 |
| P1a review carry-items (journal-before-register + 2 locking tests) | Task 8 |

Not in P1b (do not add): tool-card registry/diff cards (P2), permission-mode switcher (P2), server-side queue + steer (P4), plan-mode PlanCard polish (P4 — EnterPlanMode confirmations arrive as QuestionRequests and ExitPlanMode proposals as ApprovalRequests, so both already render through the P1b cards; the merged plan-markdown card is later polish), checkpoints (P5), multi-conversation tabs/list (P6), background-task UI (P7), jsdom/component-test infra.
