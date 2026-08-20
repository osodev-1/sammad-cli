# Coder Panel P2b — Tool Cards + Mode Switcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the coder panel legible and controllable: enrich the transcript to keep tool arguments + results (today `ToolResult` events are dropped and tool blocks are bare label strings), render per-tool cards (Shell, file edit with a shared DiffView, Grep/Glob/Read, Todo checklist, generic fallback), and add the permission-mode switcher (Plan · Default · Accept edits) wired to P2a's `/mode` route and `StatusUpdate.permission_mode`.

**Architecture:** All frontend, `control-plane/artifacts/sanad-web`, branch `coder-panel-p2b` (stacked on the P2a coder work). Tool detail is LIVE-ONLY (rebuilt from the server journal on reload, never persisted — matching P1b's "server journal is source of truth, uiState holds view state"): `reduce()` gains `ToolCall`/`ToolResult` folding correlated by `tool_call_id`, a pure `lib/coder/toolDisplay.ts` parses args/display blocks, and `toStored` keeps persisting only a lean `{kind:"tool", label}` so the zod schema is unchanged (no uiState migration). `DiffView` is hoisted out of `PlanPreview.tsx` (a clean, non-dirty file) into a shared `app/ui/DiffView.tsx`. The mode switcher reads `/turn`'s `mode` (currently ignored), drives it via a new `setCoderMode` client + `/api/coder/.../mode` proxy, and stays live via a `StatusUpdate.permission_mode` branch in `reduce()`.

**Tech Stack:** TypeScript / Next.js / React (inline `CSSProperties`, achromatic `var(--*)` tokens only). Tests: `pnpm test` (vitest, **node env — pure functions only, no component/DOM harness**) + `pnpm exec tsc --noEmit`. Spec: `docs/superpowers/specs/2026-08-12-coder-agent-panel-design.md` §Tool cards, §Mode switcher.

## Global Constraints

- **Commits are Omar-only** — `sanad: <description>`; NEVER any AI attribution. Before EVERY commit: `PATH=/Library/Developer/CommandLineTools/usr/bin:$PATH git branch --show-current` must print `coder-panel-p2b` — else STOP/BLOCKED. Prefix every git command with that PATH (host Xcode-license shim is broken).
- **Never `git add -A`.** Omar's DIRTY files (do NOT touch or stage): `app/terminal/architect/ArchitectPanel.tsx`, `app/terminal/graph/GraphPanel.tsx`, `lib/architect/transcript.ts`, `tests/unit/architect-transcript.test.ts`, `.serena/`, `.playwright-mcp/`, `nature-reserve-management-executive-report.md`. NOTE: `app/terminal/graph/PlanPreview.tsx` and `lib/blueprint/diff.ts` are CLEAN and ARE edited by this plan.
- **Gates are fast only.** `cd control-plane/artifacts/sanad-web && pnpm test <file>` (focused) → `pnpm test` (full web suite, seconds) → `pnpm exec tsc --noEmit`. There is NO component test harness (node env, no jsdom/testing-library) — JSX components are verified by `tsc` + review; all NEW testable logic must live in PURE helpers (`lib/coder/*`) with vitest tests. Do NOT run any Python/e2e suite (unaffected).
- **Tool detail is never persisted.** `toStored` keeps emitting `{kind:"tool", label}` (≤200 chars) so `coderBlockState` in `lib/sessions/state.ts` is UNCHANGED — no schema bump, no migration. Rich args/result/display live only in the in-memory model and are rebuilt from the journal on reload.
- **Achromatic design system.** Inline `CSSProperties`; `var(--ink|paper|rule|rule-strong|paper-sunken|radius-*|font-mono)` only; no hue, no new global CSS. Reuse `app/ui/theme.ts` `button.primary/secondary(size.sm)` for active/inactive segments (the RequestCards idiom) — active = primary, inactive = secondary.
- **Mode set is exactly `plan | default | accept-edits`** (yolo is absent by design). The switcher must never offer yolo.
- sanad-web commands from `control-plane/artifacts/sanad-web`.

---

### Task 1: Transcript v2 — keep tool args + results (live-only)

**Files:**
- Create: `control-plane/artifacts/sanad-web/lib/coder/toolDisplay.ts` (pure parsers + DisplayBlock types)
- Modify: `control-plane/artifacts/sanad-web/lib/coder/types.ts` (event payload types for ToolCall/ToolResult/StatusUpdate), `lib/coder/transcript.ts` (CoderBlock `tool` variant + reduce folding + toStored lean), `lib/coder/client.ts` (drop/keep `toolLabel` — see below)
- Modify: `control-plane/artifacts/sanad-web/tests/unit/coder-transcript.test.ts`; Create: `tests/unit/coder-tooldisplay.test.ts`

**Interfaces:**
- Consumes (verified wire shapes): journaled item `{kind:"event", seq, event:{type, payload}}`. `ToolCall` payload `{type:"function", id, function:{name, arguments: string|null}, extras?}` (`arguments` is a JSON string). `ToolResult` payload `{tool_call_id, return_value:{is_error, output, message, display: DisplayBlock[], extras?}}`. DisplayBlock discriminated by `type`: `shell{type:"shell", language, command}`, `diff{type:"diff", path, old_text, new_text, old_start, new_start, is_summary}`, `todo{type:"todo", items:[{title, status:"pending"|"in_progress"|"done"}]}`, `background_task{type:"background_task", task_id, kind, status, description}`, `brief{type:"brief", text}`, `unknown{type, data}`.
- Produces (Task 3 consumes):
  - `lib/coder/types.ts`: `DisplayBlock` discriminated union (the six variants above; unknown = `{type: string; [k:string]: unknown}` fallback), `ToolCallPayload`, `ToolResultPayload`, `StatusUpdatePayload {permission_mode?: string|null; plan_mode?: boolean|null; ...}`.
  - `lib/coder/toolDisplay.ts`:
    - `parseToolArgs(name: string, argumentsJson: string | null | undefined): Record<string, unknown>` — lenient `JSON.parse` (returns `{}` on null/parse-failure, never throws).
    - `toolActionLabel(name: string, args: Record<string, unknown>): string` — a concrete present-tense label using args when available: `Shell`→`` Run `<command>` `` (command clipped ~80), `WriteFile`/`StrReplaceFile`→`Edit <path>`, `ReadFile`→`Read <path>`, `Grep`→`` Grep `<pattern>` ``, `Glob`→`Find <pattern>`, else the generic map's phrase, else `Running <name>`. (Replaces the arg-less `toolLabel` for the live model; keep `toolLabel` exported for back-compat if anything else imports it — grep first.)
    - `normalizeDisplay(blocks: unknown): DisplayBlock[]` — validate/coerce a raw `display` array into typed `DisplayBlock[]`, dropping malformed entries (never throw).
  - `lib/coder/transcript.ts` `CoderBlock` tool variant becomes:
    ```ts
    | { kind: "tool"; toolCallId: string; name: string; label: string;
        args: Record<string, unknown>; result?: { isError: boolean; display: DisplayBlock[] } }
    ```
  - `reduce()` folding rules (add to the existing fold, keyed like the request-block correlation):
    - `event.type === "ToolCall"`: build a tool block `{toolCallId: payload.id, name, label: toolActionLabel(name, args), args, result: undefined}`; append (do NOT dedupe on label anymore — each call is its own card).
    - `event.type === "ToolResult"`: find the trailing tool block whose `toolCallId === payload.tool_call_id`; set its `result = {isError: return_value.is_error, display: normalizeDisplay(return_value.display)}`. If none found, ignore (a result with no visible call — rare).
    - Unknown event types still fall through to `return blocks`.
  - `toStored`: the tool case maps to `{kind:"tool", label: clip(block.label, 200)}` — args/result/toolCallId dropped. `fromStored` rehydrates `{kind:"tool", toolCallId:"", name:"", label, args:{}, result: undefined}` (inert; the live model rebuilds real detail from the journal).

- [ ] **Step 1: Failing tests**

`tests/unit/coder-tooldisplay.test.ts` — pure parser tests: `parseToolArgs("Shell", '{"command":"ls -la"}')` → `{command:"ls -la"}`; null/`"{"`/undefined → `{}` (no throw); `toolActionLabel("Shell", {command:"npm run build"})` → contains `npm run build`; `toolActionLabel("WriteFile", {path:"a/b.ts"})` → `Edit a/b.ts`; `toolActionLabel("Grep",{pattern:"foo"})` → contains `foo`; unknown name → `Running X`; `normalizeDisplay([{type:"shell",language:"bash",command:"ls"},{type:"diff",path:"f",old_text:"a",new_text:"b"},{bogus:1}])` → 2 typed blocks (bogus dropped).

`tests/unit/coder-transcript.test.ts` — add: a ToolCall then its ToolResult fold into ONE tool block with `result.display` populated and `result.isError` correct; two ToolCalls with distinct ids produce two blocks (no dedupe); a ToolResult with an unknown `tool_call_id` is ignored; `toStored` of a rich tool block yields `{kind:"tool", label}` only (no args/result keys) and still validates under `coderBlockState` (import it from `@/lib/sessions/state`, safeParse the whole stored message).

- [ ] **Step 2: RED** — `pnpm test tests/unit/coder-tooldisplay.test.ts tests/unit/coder-transcript.test.ts`.
- [ ] **Step 3: Implement** `toolDisplay.ts`, the `types.ts` additions, the `transcript.ts` fold + toStored/fromStored. Grep for `toolLabel` importers before removing/keeping it.
- [ ] **Step 4: GREEN + full web suite + tsc** — `pnpm test && pnpm exec tsc --noEmit`.
- [ ] **Step 5: Commit** — stage the coder lib files + the two test files; message `sanad: coder transcript v2 — keep tool args + results, correlated by tool_call_id`.

---

### Task 2: Extract shared `DiffView`

**Files:**
- Create: `control-plane/artifacts/sanad-web/app/ui/DiffView.tsx`
- Modify: `control-plane/artifacts/sanad-web/app/terminal/graph/PlanPreview.tsx` (use the shared component)

**Interfaces:**
- Consumes: `diffHunks`/`diffLines` from `lib/blueprint/diff.ts` (unchanged), and the exact hunk-render + achromatic styles currently inline in `PlanPreview.tsx:117-161` / styles `:237-299` (`diffWrap, diffLine, diffAdd, diffDel, diffSign, hunkHeader, hunkGap, fullToggle, content`).
- Produces (Task 3 consumes): `app/ui/DiffView.tsx` exporting
  ```tsx
  export function DiffView({ before, after, onShowFull }:
    { before: string; after: string; onShowFull?: () => void }): JSX.Element
  ```
  behavior identical to PlanPreview's current inline version: `diffHunks(before, after)` → `null` (oversize) renders `<pre>{after}</pre>`; `[]` renders "No changes to this file."; else per-hunk add/del/context lines; a "Show full file" button ONLY when `onShowFull` is provided (so a tool card can omit it). The component owns its own `const s` style block (the nine diff/hunk tokens, copied verbatim from PlanPreview so the visual is byte-identical).

- [ ] **Step 1: Create `app/ui/DiffView.tsx`** — move the `DiffView` function + its nine style tokens out of PlanPreview verbatim; make `onShowFull` optional (guard the button on it).
- [ ] **Step 2: Refactor `PlanPreview.tsx`** — delete the local `DiffView` + its now-unused style tokens; `import { DiffView } from "@/app/ui/DiffView"`; its call site (`PlanPreview.tsx:59-72`) passes `before`/`after`/`onShowFull` unchanged.
- [ ] **Step 3: tsc + full web suite** — `pnpm exec tsc --noEmit && pnpm test`. Expected: clean; no behavior change (PlanPreview renders identically). If any `blueprint-diff` test exists it stays green (diff logic untouched).
- [ ] **Step 4: Commit** — stage `app/ui/DiffView.tsx` + `PlanPreview.tsx`; message `sanad: extract shared DiffView from PlanPreview`.

---

### Task 3: Tool-card registry + per-tool cards

**Files:**
- Create: `control-plane/artifacts/sanad-web/app/terminal/coder/ToolCard.tsx` (registry + all card renderers in one file, or a `cards/` dir — implementer's call; one file is fine given they're small)
- Modify: `control-plane/artifacts/sanad-web/app/terminal/coder/CoderPanel.tsx` (render a `tool` block via `<ToolCard>` instead of the label+dot)

**Interfaces:**
- Consumes: the Task-1 `CoderBlock` tool variant (`name`, `label`, `args`, `result.display`, `result.isError`); Task-2 `DiffView`; `DisplayBlock` types from `lib/coder/types.ts`; theme `button.*`/`size`/`chip` OR the local `s` idiom (match CoderPanel's existing hand-rolled style — CoderPanel uses a local `const s`, so ToolCard should carry its own `const s` with the same `var(--*)` tokens).
- Produces: `export function ToolCard({ block, onOpenFile }: { block: <tool CoderBlock>; onOpenFile?: (path: string) => void }): JSX.Element`. Rendering by `name` / `result.display`:
  - **Shell** — the `label` (command) in a mono row; if `result` present, a compact status chip (✓ / failed from `result.isError`) and any `BriefDisplayBlock.text` from the display array. (No exit code exists on the wire — do NOT invent one.)
  - **WriteFile / StrReplaceFile** — the path (clickable → `onOpenFile(path)` when provided) + a `DiffDisplayBlock` rendered via `<DiffView before={old_text} after={new_text} />` (no `onShowFull`). `is_summary` blocks render with a "truncated" note.
  - **Grep / Glob / ReadFile** — collapsed one-liner from `label`; expandable list only if the display carries results (else just the label).
  - **SetTodoList** — a `TodoDisplayBlock` checklist (pending ○ / in_progress ◐ / done ✓ + strikethrough).
  - **Generic fallback** — `label` + a mono dump of `args` (pretty-printed, clipped) when there is no specialized card and no display blocks.
  - Streaming-safe: `result === undefined` (call in flight) renders the label with a subtle spinner/pending affordance; empty `display` degrades to the label. Never throw on missing fields.
- CoderPanel change: in the block-render switch (`CoderPanel.tsx:714-719`, the `if (b.kind === "tool")` branch), replace the dot+label with `<ToolCard block={b} onOpenFile={onOpenFile} />`. Wire `onOpenFile` from CoderPanel's existing file-open prop if present (grep `onOpenFile`/`openFile` in CoderPanel; if none, omit — it's optional).

- [ ] **Step 1: Implement `ToolCard.tsx`** — registry keyed by tool name with the specialized renderers above + generic fallback; import `DiffView`; achromatic `const s`.
- [ ] **Step 2: Wire into CoderPanel** — swap the tool-block branch to `<ToolCard>`. Keep every other branch untouched.
- [ ] **Step 3: tsc + full web suite** — `pnpm exec tsc --noEmit && pnpm test` (green; the transcript tests from Task 1 already cover the data; the JSX is review-gated).
- [ ] **Step 4: Commit** — stage `ToolCard.tsx` + `CoderPanel.tsx`; message `sanad: coder tool cards — shell, file diff, grep/glob, todo, generic`.

---

### Task 4: Mode plumbing — client, proxy, /turn read-back, StatusUpdate

**Files:**
- Modify: `control-plane/artifacts/sanad-web/lib/coder/types.ts` (`CoderTurnState` gains `mode?: string`), `lib/coder/client.ts` (`fetchCoderTurn` surfaces `mode`; add `setCoderMode`), `lib/coder/transcript.ts` (StatusUpdate → a mode signal; see below)
- Create: `control-plane/artifacts/sanad-web/app/api/coder/conversations/[cid]/mode/route.ts`
- Modify: `tests/unit/coder-client.test.ts`

**Interfaces:**
- Consumes: backend `POST /internal/coder/conversations/{cid}/mode {mode}` → `{ok, mode}` / 409 `not_started` / 400 `invalid_mode`; `/turn` response `{turn, alive, pendingRequests, mode}`; wire `StatusUpdate` event `payload.permission_mode: string|null`.
- Produces (Task 5 consumes):
  - `app/api/coder/conversations/[cid]/mode/route.ts` — a body-forwarding POST proxy mirroring `respond/route.ts` (auth via `authenticateCoderPanel`, `session` query passthrough, `workspaceFetch` to `/internal/coder/conversations/${cid}/mode`, `relayJson`).
  - `lib/coder/client.ts`:
    - `fetchCoderTurn` return type extended so `mode` (from the response, `?? undefined`) is surfaced on `CoderTurnState`.
    - `setCoderMode(cid: string, mode: string, sessionId?: string): Promise<{ ok: boolean; code?: string; message?: string }>` — modeled on `respondCoder` (POST JSON `{mode}`, parse `{ok}` / error envelope `b?.error?.code|message`).
  - `lib/coder/transcript.ts`: a way to surface the live mode from a `StatusUpdate` event. Since `reduce()` returns `CoderBlock[]` (not conversation-level state), add a SEPARATE pure helper `modeFromEvent(item: CoderItem): string | null` in `client.ts` (returns `payload.permission_mode` when `event.type === "StatusUpdate"` and it's a non-null string, else `null`) — CoderPanel's `consume` calls it alongside the existing extractors to update mode state. Do NOT shoehorn conversation state into the block reducer.

- [ ] **Step 1: Failing client tests** — extend `tests/unit/coder-client.test.ts` (fetch stubbed): `setCoderMode` POSTs to `/api/coder/conversations/<cid>/mode?session=...` with body `{"mode":"accept-edits"}` and returns `{ok:true}` on 200; maps a 409 body `{error:{code:"not_started"}}` to `{ok:false, code:"not_started"}`. `fetchCoderTurn` surfaces `mode` from a stubbed `/turn` response. `modeFromEvent` returns the mode for a StatusUpdate event and `null` for a ToolCall / a null permission_mode.
- [ ] **Step 2: RED** — `pnpm test tests/unit/coder-client.test.ts`.
- [ ] **Step 3: Implement** the proxy route, `setCoderMode`, `fetchCoderTurn` mode surfacing, `modeFromEvent`.
- [ ] **Step 4: GREEN + full suite + tsc**.
- [ ] **Step 5: Commit** — stage the two lib files + the new route + the test; message `sanad: coder mode client + /mode proxy + /turn read-back + StatusUpdate mode`.

---

### Task 5: Mode switcher UI in CoderPanel

**Files:**
- Modify: `control-plane/artifacts/sanad-web/app/terminal/coder/CoderPanel.tsx`

**Interfaces:**
- Consumes: Task-4 `setCoderMode`, `fetchCoderTurn` mode, `modeFromEvent`.
- Produces (UI only; no exported API): a `mode` state in CoderPanel (`"plan" | "default" | "accept-edits"`, initial `"default"`), seeded from `begin()`'s `fetchCoderTurn` result (`state.mode ?? "default"`), updated live in `consume()` via `modeFromEvent`, and driven by a segmented control:
  - Placement: a row in the composer footer (or just above it) — `Plan · Default · Accept edits`, active segment = `button.primary(size.sm)`-equivalent, inactive = `button.secondary(size.sm)`-equivalent (match CoderPanel's local `s` idiom or import the factories like RequestCards).
  - One-line caption under the control reflecting the active mode's meaning: default → "Edits auto-approved · shell asks"; accept-edits → "Edits auto-approved · shell asks"; wait — differentiate: default → "File edits ask · shell asks" is WRONG per P2a semantics. Use the ACTUAL P2a semantics: default → "Edits auto-approved, shell asks"; accept-edits → "Edits auto-approved (incl. outside workspace), shell asks"; plan → "Read-only — proposes a plan, makes no changes". (Confirm exact wording against P2a's `apply_permission_mode` sets: default auto-approves `edit file`; accept-edits adds `edit file outside of working directory`; plan = plan_mode.)
  - Interaction: clicking a segment optimistically sets local `mode`, calls `setCoderMode(cid, mode)`, and on `{ok:false}` REVERTS to the prior mode + shows the error briefly (reuse CoderPanel's existing notice/⚠ affordance). Disabled while no live conversation (`!cid` / phase `error`/`starting`).
- Do NOT add yolo. Do NOT block the composer on mode.

- [ ] **Step 1: Implement** the mode state (seed + live update + optimistic/revert), the segmented control, and the caption, in CoderPanel.
- [ ] **Step 2: tsc + full web suite** — `pnpm exec tsc --noEmit && pnpm test` (green; JSX review-gated).
- [ ] **Step 3: Manual QA note** — write into the task report a short manual script: enable the panel (`CODER_ENABLED=1` + allowlist + `TRUST_STORE_KEY`/`AGENT_USER`), open a conversation, switch to Accept edits and confirm a subsequent file write auto-approves while shell still prompts, switch to Plan and confirm read-only, reload and confirm the switcher reflects the persisted mode from `/turn`.
- [ ] **Step 4: Commit** — stage `CoderPanel.tsx`; message `sanad: coder mode switcher — plan/default/accept-edits, optimistic with revert`.

---

## P2b exit criteria (spec traceability)

| Spec P2b item | Where |
|---|---|
| Tool cards render real data (not label strings) | Task 1 (model) + Task 3 (cards) |
| Shell / FileEdit / Grep-Glob / Todo / generic cards | Task 3 |
| DiffView extraction (shared, reused by file-edit card) | Task 2 |
| Mode switcher UI (plan/default/accept-edits, no yolo) | Task 5 |
| `/api/coder/.../mode` proxy | Task 4 |
| Live mode via StatusUpdate + /turn seed | Task 4 (signal) + Task 5 (state) |
| Tool detail never persisted (server journal is truth) | Task 1 (toStored lean, zod unchanged) |

Not in P2b: subagent/background-task cards + drawer (P7); steer/queue server-side (P4); checkpoints (P5). Carry-forward from P2a already ledgered (busy-guard on /mode, /turn mode under-report on resume — the Task-4 `/turn` seed + Task-5 read-back partially address the latter).
