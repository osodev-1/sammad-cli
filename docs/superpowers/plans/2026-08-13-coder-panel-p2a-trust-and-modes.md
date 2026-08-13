# Coder Panel P2a — Trust Hardening + Permission Modes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the "agent self-trusts a skill" persistence attack (HMAC-signed trust store + inline hash delivery — the spec's trust-hardening gate, adapted to the EFS reality that file ownership cannot protect the store), then unlock permission modes: `set_permission_mode` wire method (default / accept-edits / plan), per-pattern shell approvals, the `.sanad/**` write carve-out, default-mode seeding for new coder conversations, and agent-uid ulimits.

**Architecture:** The trust store stays at `/data/blueprint-trust.json` (durable EFS) but gains an HMAC-SHA256 signature keyed by `TRUST_STORE_KEY` — an agentd-only env (root process env, unreachable from the agent uid via /proc), derived per-user by sanad-web at task registration. agentd verifies on every load (bad/missing signature → empty set + `"tampered"` surfaced) and delivers the verified hash set INLINE to every spawned agent (`SANAD_BLUEPRINT_TRUST_SHA256S`); the CLI prefers the inline set and never trusts the file directly on governed machines. Modes ride the existing `auto_approve_actions` machinery: `set_permission_mode` (wire 1.10→1.11) swaps the mode-managed file-edit actions, delegates `plan` to `set_plan_mode`, and emits `StatusUpdate.permission_mode`; new coder conversations get `default` set right after spawn (no state.json pre-seeding — `Session.find` requires `context.jsonl` + workdir metadata, so file seeding is fragile by design).

**Tech Stack:** Python 3.14 (terminal-server: `uv run pytest tests/ -q`, ~13s; kimi_cli: `uv run pytest tests/ -q` from repo root, e2e in `tests_e2e/`); TypeScript (sanad-web: `pnpm test`, `pnpm exec tsc --noEmit`). Spec: `docs/superpowers/specs/2026-08-12-coder-agent-panel-design.md` §Permission modes, §Platform guards. Base: main @ 3ea4fd77.

## Global Constraints

- **Commits are Omar-only** — `sanad: <description>`; NEVER any AI attribution. Before EVERY commit: `PATH=/Library/Developer/CommandLineTools/usr/bin:$PATH git branch --show-current` must print `coder-panel-p2a` (Omar switches branches in other terminals) — else STOP/BLOCKED. Prefix every git command with that PATH (host Xcode-license shim broken).
- **Never `git add -A`** — the tree has Omar's unrelated dirty files (`control-plane/artifacts/sanad-web/app/terminal/architect/ArchitectPanel.tsx`, `app/terminal/graph/GraphPanel.tsx`, `lib/architect/transcript.ts`, `tests/unit/architect-transcript.test.ts`, `.serena/`, a report md). Stage only named files.
- **Fail closed everywhere:** missing `TRUST_STORE_KEY` on a governed (task-mode) machine → store loads EMPTY (+ every entry `"tampered"`); bad signature → same; the wire method accepts ONLY `"default" | "accept-edits" | "plan"` (yolo is deliberately absent — panel yolo is deferred by locked decision); `.sanad` edits are never session-cacheable and never in any mode's auto-approve set.
- **Back-compat:** legacy unsigned stores and the legacy `SANAD_BLUEPRINT_TRUST` file-path env keep working for local/dev CLIs (no `TRUST_STORE_KEY`, railway mode); legacy cached `"run command"` approvals act as a wildcard for the new per-head actions. Architect spawns are unchanged except inline trust delivery (same as all spawns).
- **Wire protocol bump 1.10 → 1.11** happens exactly once (Task 5) — `wire/protocol.py:1` plus the agentd-side constant `wire_runner.py:_WIRE_PROTOCOL_VERSION`.
- **Known snapshot blast radius (deliberate):** `StatusUpdate` gains `permission_mode` and shell action strings gain command heads — `tests_e2e` inline-snapshots embed full StatusUpdate payloads and `"action": "run command"` literals; Task 6 updates them mechanically and its review checks every snapshot diff is ONLY the expected field/string changes.
- terminal-server commands from `terminal-server/`; kimi_cli tests from repo root; sanad-web from `control-plane/artifacts/sanad-web`.

---

### Task 1: HMAC-signed trust store

**Files:**
- Modify: `terminal-server/src/sanad_terminal/blueprint_trust.py`
- Modify: `terminal-server/src/sanad_terminal/settings.py` (+ `trust_store_key: str = ""`, env `TRUST_STORE_KEY`)
- Modify: `terminal-server/src/sanad_terminal/routes_blueprint.py` (thread the key into every load/record/remove/statuses call)
- Modify: `terminal-server/tests/test_blueprint_trust.py`, `terminal-server/tests/test_settings.py`; existing `tests/test_routes_blueprint.py` trust tests must stay green (railway-mode fixtures have no key → legacy unsigned path)

**Interfaces:**
- Consumes: current store shape `{"version": 1, "entries": {...}}` (`blueprint_trust.py:119-130` `_write_store`), `load_trust`/`record_trust`/`remove_trust`/`trust_statuses` signatures.
- Produces (Tasks 2, 7 consume):
  - All four public functions gain a keyword-only `key: str = ""` parameter. Empty key = legacy unsigned mode (today's behavior byte-for-byte).
  - Signed store shape: `{"version": 2, "entries": {...}, "sig": "<hex hmac-sha256 over canonical entries JSON>"}` where the signed payload is `json.dumps(entries, sort_keys=True, separators=(",", ":"))`.
  - With a key: `_write_store` signs; `load_trust` verifies — v2+valid → entries; v2+invalid, v1-unsigned, or malformed → `{}` AND `load_trust` gains a companion `load_trust_checked(root, key) -> tuple[dict, bool]` returning `(entries, tampered)`; `trust_statuses(root, key)` marks every on-disk gated file `"tampered"` (new `TrustState` literal) when the store fails verification.
  - Migration: a valid legacy v1 store loaded WITH a key is treated as tampered=False but empty=False? NO — fail closed: v1-with-key → `(entries={}, tampered=True)`. The one-time migration path is agentd re-recording on next apply/manual review (writes always produce v2 when a key is present). Document this in the module docstring.

- [ ] **Step 1: Write the failing tests**

Append to `terminal-server/tests/test_blueprint_trust.py` (reuse its `_workspace`/`_write_skill` helpers):

```python
KEY = "k" * 32


def test_signed_store_round_trips_with_key(tmp_path):
    root = _workspace(tmp_path)
    _write_skill(root, "review", "do the review")
    digest = file_sha256(root / ".sanad/skills/review/SKILL.md")
    record_trust(root, {".sanad/skills/review/SKILL.md": digest}, "manual", key=KEY)
    entries, tampered = load_trust_checked(root, key=KEY)
    assert not tampered
    assert entries[".sanad/skills/review/SKILL.md"]["sha256"] == digest
    raw = json.loads(trust_file_for(root).read_text())
    assert raw["version"] == 2 and isinstance(raw.get("sig"), str)


def test_tampered_store_fails_closed(tmp_path):
    root = _workspace(tmp_path)
    _write_skill(root, "review", "do the review")
    digest = file_sha256(root / ".sanad/skills/review/SKILL.md")
    record_trust(root, {".sanad/skills/review/SKILL.md": digest}, "manual", key=KEY)
    # The in-session-agent attack: edit entries directly, keep the old sig.
    raw = json.loads(trust_file_for(root).read_text())
    raw["entries"][".sanad/skills/evil/SKILL.md"] = {"sha256": "f" * 64, "source": "manual", "at": 0}
    trust_file_for(root).write_text(json.dumps(raw))
    entries, tampered = load_trust_checked(root, key=KEY)
    assert tampered and entries == {}
    statuses = trust_statuses(root, key=KEY)
    assert statuses and all(e["state"] == "tampered" for e in statuses)


def test_legacy_unsigned_store_with_key_fails_closed(tmp_path):
    root = _workspace(tmp_path)
    _write_skill(root, "review", "x")
    digest = file_sha256(root / ".sanad/skills/review/SKILL.md")
    record_trust(root, {".sanad/skills/review/SKILL.md": digest}, "manual")  # no key: v1
    entries, tampered = load_trust_checked(root, key=KEY)
    assert tampered and entries == {}


def test_no_key_keeps_legacy_behavior(tmp_path):
    root = _workspace(tmp_path)
    _write_skill(root, "review", "x")
    digest = file_sha256(root / ".sanad/skills/review/SKILL.md")
    record_trust(root, {".sanad/skills/review/SKILL.md": digest}, "manual")
    entries, tampered = load_trust_checked(root)
    assert not tampered and entries
    raw = json.loads(trust_file_for(root).read_text())
    assert raw["version"] == 1 and "sig" not in raw
```

Add the needed imports (`json`, `load_trust_checked`, `file_sha256`, `record_trust`, `trust_file_for`, `trust_statuses`) to the file's import block. `tests/test_settings.py` gains:

```python
def test_trust_store_key_parses(base_env):
    assert TerminalSettings.load(env=base_env).trust_store_key == ""
    s = TerminalSettings.load(env={**base_env, "TRUST_STORE_KEY": "abc"})
    assert s.trust_store_key == "abc"
```

- [ ] **Step 2: RED** — `cd terminal-server && uv run pytest tests/test_blueprint_trust.py tests/test_settings.py -q`; new tests fail (no `load_trust_checked`, no `key` kwarg, no setting).

- [ ] **Step 3: Implement**

`settings.py`: field `trust_store_key: str = ""` under the coder section with comment `# HMAC key for the blueprint trust store — agentd-env only, NEVER in child env. Empty = legacy unsigned store (local/dev/railway).`; parse `trust_store_key=e.get("TRUST_STORE_KEY", ""),`.

`blueprint_trust.py`:

```python
def _canonical(entries: dict[str, dict]) -> bytes:
    return json.dumps(entries, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _sign(entries: dict[str, dict], key: str) -> str:
    return hmac.new(key.encode("utf-8"), _canonical(entries), hashlib.sha256).hexdigest()
```

`_write_store(root, entries, *, key: str = "")`: with a key, payload becomes `{"version": 2, "entries": entries, "sig": _sign(entries, key)}`; without, today's v1 shape unchanged. `record_trust`/`remove_trust` gain `*, key: str = ""` and pass through (they read-modify-write: their internal load must use `load_trust_checked` and, when tampered, start from `{}` — a re-record after tamper rebuilds a clean signed store).

```python
def load_trust_checked(root: Path, *, key: str = "") -> tuple[dict[str, dict], bool]:
    """(entries, tampered). Empty key = legacy: never tampered, current behavior.
    With a key: only a v2 store with a valid signature loads; anything else —
    bad sig, v1, malformed — is (({}), True): fail closed, surfaced."""
    ...
```

`load_trust(root, *, key="")` keeps its old signature as `load_trust_checked(...)[0]`. `trust_statuses(root, *, key="")`: when `tampered`, every on-disk gated file reports `state: "tampered"`; extend `TrustState = Literal["trusted", "untrusted", "changed", "tampered"]`. Update the module docstring: replace the "Known v1 limit" sentence with the v2 design (HMAC + inline delivery; key never in child env; EFS uid mapping is why ownership can't protect the file).

`routes_blueprint.py`: every `load_trust`/`record_trust`/`remove_trust`/`trust_statuses` call site (apply `:346-365`, rollback `:429-443`, `GET/POST /trust` `:453-488`, `_annotate_trust` `:112`) passes `key=_settings(request).trust_store_key` — check how `_settings` is accessed in this file (it may need the `Request` threaded into `_annotate_trust` callers; follow the existing parameter style).

- [ ] **Step 4: GREEN + full suite** — `uv run pytest tests/ -q` (177+ tests; the existing trust tests pass because they call without `key`).

- [ ] **Step 5: Commit** — stage the four terminal-server files; message `sanad: HMAC-signed trust store — tamper fails closed, keyless stays legacy`.

---

### Task 2: Inline trust delivery to spawned agents (both sides)

**Files:**
- Modify: `terminal-server/src/sanad_terminal/workspace.py` (`build_child_env` gains `trusted_hashes: Sequence[str] | None = None`)
- Modify: `terminal-server/src/sanad_terminal/routes_coder.py`, `routes_architect.py`, `app.py` (PTY spawn site) — compute the verified hash set at each spawn and pass it
- Modify: `src/kimi_cli/sanad/activation.py`, `src/kimi_cli/skill/__init__.py` (inline env preferred over file)
- Modify: `terminal-server/tests/test_workspace.py`, `tests/sanad/test_activation.py`, `tests/sanad/test_skill_trust.py`

**Interfaces:**
- Produces: child env var `SANAD_BLUEPRINT_TRUST_SHA256S` = comma-joined sha256 hex digests of the VERIFIED store (empty string when none/tampered). When `trusted_hashes is not None`, `build_child_env` sets the inline var and does NOT set the legacy `SANAD_BLUEPRINT_TRUST` path var (governed machines move to inline wholesale); `None` keeps today's behavior (legacy path var) for callers not yet migrated — after this task all three agentd spawn sites pass it, so the legacy var only appears in local-dev flows that don't use `build_child_env`.
- CLI precedence (both gates): `SANAD_BLUEPRINT_TRUST_SHA256S` present (even empty) → use it as the trusted set, ignore the file var entirely; else legacy file behavior unchanged. Empty inline set → nothing loads (fail closed).

- [ ] **Step 1: Failing tests**

`terminal-server/tests/test_workspace.py` (mirror the existing env assertions around `:61`):

```python
def test_inline_trust_env_replaces_file_var(tmp_path):
    env = build_child_env(
        user_dir=tmp_path, session_token="sess_x", api_base_url="https://cp",
        cols=80, rows=24, trusted_hashes=["a" * 64, "b" * 64],
    )
    assert env["SANAD_BLUEPRINT_TRUST_SHA256S"] == "a" * 64 + "," + "b" * 64
    assert "SANAD_BLUEPRINT_TRUST" not in env


def test_no_hashes_keeps_legacy_file_var(tmp_path):
    env = build_child_env(
        user_dir=tmp_path, session_token="sess_x", api_base_url="https://cp",
        cols=80, rows=24,
    )
    assert env["SANAD_BLUEPRINT_TRUST"].endswith("blueprint-trust.json")
    assert "SANAD_BLUEPRINT_TRUST_SHA256S" not in env
```

`tests/sanad/test_activation.py` + `tests/sanad/test_skill_trust.py`: mirror one existing file-based test each into an inline variant (monkeypatch `SANAD_BLUEPRINT_TRUST_SHA256S` to the good hash → loads; to `""` → nothing loads even though the legacy file var points at a valid store — proves precedence). Copy the exact fixture idioms already in those files (the explorer confirmed env monkeypatch patterns at `test_skill_trust.py:52-97`, `test_activation.py:44-95`).

- [ ] **Step 2: RED** — terminal-server: `uv run pytest tests/test_workspace.py -q`; kimi: `uv run pytest tests/sanad/test_activation.py tests/sanad/test_skill_trust.py -q` (from repo root).

- [ ] **Step 3: Implement**

`workspace.py`: `build_child_env(..., trusted_hashes: Sequence[str] | None = None)`; in the env dict replace the unconditional `"SANAD_BLUEPRINT_TRUST": ...` entry with:

```python
    if trusted_hashes is not None:
        # Inline delivery (P2a): the CLI gets the VERIFIED hash set at exec time
        # and never reads the store file — an in-session edit of the EFS store
        # can no longer poison gates (the signature check catches it at the
        # next spawn, and this process's set is already fixed).
        env["SANAD_BLUEPRINT_TRUST_SHA256S"] = ",".join(trusted_hashes)
    else:
        env["SANAD_BLUEPRINT_TRUST"] = str(user_dir / "blueprint-trust.json")
```

(Adapt to the file's actual dict-literal structure — it builds one dict; convert the entry accordingly.)

Spawn sites — one shared helper in `workspace.py`:

```python
def verified_trust_hashes(workspace_root: Path, key: str) -> list[str]:
    """Sorted sha256 set from the signed store; [] when absent or tampered."""
    from sanad_terminal.blueprint_trust import load_trust_checked

    entries, tampered = load_trust_checked(workspace_root, key=key)
    if tampered:
        return []
    return sorted(
        e["sha256"] for e in entries.values() if isinstance(e.get("sha256"), str)
    )
```

`routes_coder.py:_spawn` and `routes_architect.py:start`: `trusted_hashes=verified_trust_hashes(root, settings.trust_store_key)` added to their `build_child_env` calls. `app.py` PTY spawn: find the PTY session spawn's `build_child_env` call (search `build_child_env(` in app.py / the terminal ws handler) and pass the same, computing the workspace root the way that call site already does.

CLI side — `activation.py:_trusted_hashes` gains the inline branch FIRST:

```python
    inline = os.environ.get("SANAD_BLUEPRINT_TRUST_SHA256S")
    if inline is not None:
        return frozenset(h for h in inline.split(",") if h)
```

`skill/__init__.py:_sanad_trust_gate` gets the identical branch before the file-path read (keep the `.sanad`-parts precondition above both).

- [ ] **Step 4: GREEN + both full suites** — `cd terminal-server && uv run pytest tests/ -q`; from repo root `uv run pytest tests/ -q` (kimi unit suite; do NOT run tests_e2e here).

- [ ] **Step 5: Commit** — stage the six files across both trees; message `sanad: inline trust delivery — verified hashes at spawn, file gate retired on governed machines`.

---

### Task 3: sanad-web derives + injects `TRUST_STORE_KEY`

**Files:**
- Modify: `control-plane/artifacts/sanad-web/lib/compute/tokens.ts` (+ `deriveTrustStoreKey`)
- Modify: `control-plane/artifacts/sanad-web/lib/compute/aws.ts` (task-def env gains `TRUST_STORE_KEY`)
- Modify: `control-plane/artifacts/sanad-web/tests/unit/compute-tokens.test.ts`

**Interfaces:**
- Produces: `deriveTrustStoreKey(userId: string): string` = `base64url(HMAC-SHA256(TERMINAL_MACHINE_KEY, userId + ":trust-store"))` — stable across task runs (no nonce — signatures must survive machine restarts), per-user, secret derived from an env sanad-web already holds. Mirror `deriveAgentdToken`'s implementation style in the same file (read it first; reuse its hmac helper and env access).
- `aws.ts` `registerTaskDefinition`: the container env list gains `{ name: "TRUST_STORE_KEY", value: deriveTrustStoreKey(userId) }` — find where `AGENTD_TOKEN`/`MACHINE_NONCE` are injected and add alongside (the function already has `userId` in scope; verify and adapt).

- [ ] **Step 1: Failing test** — append to `tests/unit/compute-tokens.test.ts` (mirror its existing derivation tests): stable output for same user, different across users, differs from `deriveAgentdToken` output for the same inputs, and changes when `TERMINAL_MACHINE_KEY` changes (env save/restore per the file's pattern).
- [ ] **Step 2: RED** — `pnpm test tests/unit/compute-tokens.test.ts`.
- [ ] **Step 3: Implement both files.** In `aws.ts`, keep the change minimal — one env entry; do not touch cpu/memory/ports.
- [ ] **Step 4: GREEN** — `pnpm test` full + `pnpm exec tsc --noEmit`.
- [ ] **Step 5: Commit** — three files; message `sanad: derive TRUST_STORE_KEY per user — stable HMAC key into the task env`.

---

### Task 4: Per-pattern shell approvals + `.sanad` carve-out (kimi_cli)

**Files:**
- Create: `src/kimi_cli/tools/shell/approval_pattern.py`
- Modify: `src/kimi_cli/tools/shell/__init__.py` (both approval sites), `src/kimi_cli/tools/file/__init__.py` (`FileActions`), `src/kimi_cli/tools/file/write.py`, `src/kimi_cli/tools/file/replace.py`, `src/kimi_cli/soul/approval.py` (`also_cached_as`, uncacheable actions)
- Create: `tests/tools/test_shell_approval_pattern.py`; Modify: `tests/tools/test_write_file.py` or a new `tests/tools/test_sanad_carveout.py` (follow whichever mirrors cleanest — read `tests/tools/test_write_file.py` first)

**Interfaces:**
- `approval_pattern.action_for(command: str) -> str`: extracts command head(s) — split the command on unquoted `|`, `&&`, `||`, `;`, `&` boundaries (a lightweight tokenizer using `shlex.split` per segment is fine; on shlex failure fall back to whitespace split), take each segment's first token, strip leading `VAR=val` env assignments and any path prefix (`/usr/bin/git` → `git`), dedupe preserving order. Single head → `run command (git)`; multiple → `run command (git, sed)` (comma+space, original order); no derivable head → the legacy `run command`. Background variant: same via a `prefix` parameter — `action_for(command, prefix="run background command")`.
- `Approval.request(..., also_cached_as: Sequence[str] = ())`: the cache-check branch (`approval.py:262-280`) also matches any of these (legacy wildcard support); the write-back (`approve_for_session`, `:354-379`) still caches ONLY the primary `action`.
- `Approval` gains `UNCACHEABLE_ACTIONS: frozenset[str] = frozenset({FileActions.EDIT_SANAD})` — wait, approval.py must not import tools; instead `request` gains `cacheable: bool = True`: when False, the interactive `approve_for_session` choice is treated as plain `approve` (no cache write, no pending-resolve loop) — implement by branching in the `approve_for_session` case.
- `FileActions.EDIT_SANAD = "edit sanad definition"` — chosen in `write.py`/`replace.py` when the resolved path is inside `<work_dir>/.sanad` (compute with the same `is_within_directory` helper used by `is_within_workspace` — import from `kimi_cli.utils.path`); this branch takes precedence over EDIT/EDIT_OUTSIDE and passes `cacheable=False`. Mode sets (Task 5) never include it.
- Shell call sites: foreground action `action_for(command)` with `also_cached_as=("run command",)`; background `action_for(command, prefix="run background command")` with `also_cached_as=("run background command",)`.

- [ ] **Step 1: Failing pattern tests** — `tests/tools/test_shell_approval_pattern.py` (plain functions, no fixtures needed; module-level Windows skip like `test_shell_bash.py`):

```python
from kimi_cli.tools.shell.approval_pattern import action_for


def test_single_head():
    assert action_for("git status") == "run command (git)"


def test_path_and_env_prefixes_stripped():
    assert action_for("FOO=1 /usr/bin/git log") == "run command (git)"


def test_pipeline_collects_heads_in_order():
    assert action_for("git log | grep fix && sed -i s/a/b/ f.txt") == "run command (git, grep, sed)"


def test_duplicate_heads_dedupe():
    assert action_for("git add . && git commit") == "run command (git)"


def test_unparseable_falls_back_to_legacy():
    assert action_for("") == "run command"
    assert action_for("   ") == "run command"


def test_background_prefix():
    assert action_for("npm run dev", prefix="run background command") == "run background command (npm)"


def test_quoted_separators_are_not_boundaries():
    assert action_for("echo 'a && b'") == "run command (echo)"
```

Carve-out test (in the file-tool test file you chose; mirror its fixture usage): a `WriteFile` to `<work_dir>/.sanad/skills/x/SKILL.md` requests action `"edit sanad definition"`, and an `approve_for_session` response does NOT suppress the approval prompt for a second `.sanad` write (assert two approval requests occur). Also: a write to a normal workspace path still uses `"edit file"`.

- [ ] **Step 2: RED** — `uv run pytest tests/tools/test_shell_approval_pattern.py -q` (module missing).
- [ ] **Step 3: Implement** — `approval_pattern.py` (~60 lines, pure); the two shell sites; `FileActions.EDIT_SANAD`; the ternary → explicit if/elif in BOTH `write.py:138-142` and `replace.py:153-157` (compute `.sanad` membership first); `approval.py` `also_cached_as` + `cacheable`.
- [ ] **Step 4: GREEN** — `uv run pytest tests/tools/ -q` then the full kimi unit suite `uv run pytest tests/ -q`. Do NOT run tests_e2e (Task 6 owns their snapshot updates).
- [ ] **Step 5: Commit** — message `sanad: per-pattern shell approvals + .sanad edit carve-out — uncacheable by design`.

---

### Task 5: `set_permission_mode` wire method + `StatusUpdate.permission_mode` (kimi_cli)

**Files:**
- Modify: `src/kimi_cli/wire/jsonrpc.py`, `src/kimi_cli/wire/server.py`, `src/kimi_cli/wire/protocol.py` (1.10→1.11), `src/kimi_cli/wire/types.py` (`StatusUpdate.permission_mode: str | None = None`), `src/kimi_cli/soul/approval.py` (mode application helper)
- Create: unit test `tests/sanad/test_permission_mode.py` (wire-level, using the existing wire test harness style — find how `tests/` unit-tests the wire server, or drive `Approval`/state directly plus a jsonrpc-parse test)

**Interfaces:**
- New message (mirror `JSONRPCSetPlanModeMessage` exactly, `jsonrpc.py:152-161`):

```python
class _SetPermissionModeParams(BaseModel):
    mode: Literal["default", "accept-edits", "plan"]
    model_config = ConfigDict(extra="ignore")


class JSONRPCSetPermissionModeMessage(_MessageBase):
    method: Literal["set_permission_mode"] = "set_permission_mode"
    id: str
    params: _SetPermissionModeParams
```

Add to the `JSONRPCInMessage` union and `JSONRPC_IN_METHODS`.
- Mode semantics (implement as `Approval.apply_permission_mode(mode: str) -> None` in `approval.py`, so state persistence rides the existing `notify_change` → `save_state` seam):
  - `MODE_MANAGED_ACTIONS = frozenset({"edit file", "edit file outside of working directory"})` (module constant; matches `FileActions.EDIT`/`EDIT_OUTSIDE` values — do NOT import tools; duplicate the literals with a comment naming the source enum).
  - `default` → `auto_approve_actions = (current - MODE_MANAGED_ACTIONS) | {"edit file"}`; `accept-edits` → `(current - MODE_MANAGED_ACTIONS) | {"edit file", "edit file outside of working directory"}`. Per-pattern shell entries and anything else survive mode switches untouched. Both also force `yolo = False` (a mode switch is an explicit posture statement).
  - `plan` → approvals untouched; the SERVER handler delegates to the existing `set_plan_mode_from_manual(True)` path. Choosing `default`/`accept-edits` while plan mode is on → handler calls `set_plan_mode_from_manual(False)` first, then applies the mode.
- Server handler `_handle_set_permission_mode` (mirror `_handle_set_plan_mode`, `server.py:774-794`): applies the semantics, emits `StatusUpdate(permission_mode=mode, plan_mode=<current plan state>)`, appends to the wire file, returns `{"status": "ok", "permission_mode": mode}`. Register in `_dispatch_msg`'s match.
- `StatusUpdate.permission_mode: str | None = None` with docstring `"""Approval posture name (default/accept-edits/plan). None means no change."""`.
- Protocol: `wire/protocol.py:1` → `"1.11"`.

- [ ] **Step 1: Failing tests** — `tests/sanad/test_permission_mode.py`: (a) jsonrpc adapter parses `{"method":"set_permission_mode","id":"1","params":{"mode":"accept-edits"}}` into the new type and rejects `{"mode":"yolo"}` (ValidationError); (b) `Approval.apply_permission_mode` matrix: starting from a state with `{"run command (git)", "edit file outside of working directory"}`, `default` yields `{"run command (git)", "edit file"}`; `accept-edits` yields `{"run command (git)", "edit file", "edit file outside of working directory"}`; yolo forced False; `notify_change` fired (assert via the `on_change` callback recording).
- [ ] **Step 2: RED**, **Step 3: Implement**, **Step 4: GREEN** — `uv run pytest tests/sanad/test_permission_mode.py tests/ -q` (unit suite only).
- [ ] **Step 5: Commit** — message `sanad: set_permission_mode wire method — mode-managed approvals, protocol 1.11`.

---

### Task 6: e2e snapshot updates (deliberate blast radius)

**Files:**
- Modify: `tests_e2e/test_wire_approvals_tools.py` (+ any other `tests_e2e/*` file whose snapshots embed `StatusUpdate` payloads or `"action": "run command"` — grep first: `grep -rln '"plan_mode"\|run command' tests_e2e/`)

**Interfaces:** none produced — this task re-records inline snapshots so the suite is green with Tasks 4+5 landed.

- [ ] **Step 1: Run the e2e suite to enumerate breakage** — `uv run pytest tests_e2e/ -q 2>&1 | tail -20` (these run a real scripted wire subprocess, no LLM — check the file header/conftest for any env prerequisites first; if the suite needs anything unavailable (e.g. a model endpoint), STOP and report BLOCKED with the exact error rather than skipping).
- [ ] **Step 2: Re-record** — `uv run pytest tests_e2e/ --inline-snapshot=fix -q` (inline_snapshot's fix mode; verify the flag with `uv run pytest --help | grep inline` and adapt if the project pins a different invocation).
- [ ] **Step 3: Audit every hunk** — `PATH=... git diff` and confirm each snapshot change is ONLY: (a) a new `"permission_mode": null` (or set) key in StatusUpdate payloads, (b) action strings gaining `(head)` suffixes, (c) descriptions unchanged. ANY other diff = investigate before committing; revert unrelated churn.
- [ ] **Step 4: Full e2e green** — `uv run pytest tests_e2e/ -q`.
- [ ] **Step 5: Commit** — message `sanad: re-record wire e2e snapshots — permission_mode field, per-head shell actions`.

---

### Task 7: terminal-server — mode route, default seeding, ulimits

**Files:**
- Modify: `terminal-server/src/sanad_terminal/wire_runner.py` (generic request helper + `_WIRE_PROTOCOL_VERSION` → `"1.11"` + preexec rlimits), `coder_runner.py` (`set_permission_mode` + `permission_mode` tracking), `routes_coder.py` (`POST /conversations/{cid}/mode`, create-time default, mode in `/turn`), `pty_session.py` (preexec rlimits), `settings.py` (`agent_rlimit_nproc: int = 512`, `agent_rlimit_fsize: int = 4 * 1024**3`, envs `AGENT_RLIMIT_NPROC`/`AGENT_RLIMIT_FSIZE`, `0` disables)
- Modify: `terminal-server/tests/test_wire_runner.py`, `tests/test_routes_coder.py`, `tests/_fake_coder_wire.py` (handle `set_permission_mode` → reply `{"status":"ok","permission_mode":<mode>}` and emit a `StatusUpdate` event), `tests/test_settings.py`

**Interfaces:**
- `WireRunner.call(method: str, params: dict) -> dict`: sends a JSON-RPC request with a fresh `_next_id`, registers a pending future (`_new_pending`), awaits the response with a 10s timeout, raises `WireRunnerError("call_failed", ...)` on error responses/timeouts. (The pending-future machinery exists — `initialize` uses it; generalize, and have `start()` use `call` internally if trivial, else leave `start()` untouched.)
- `CoderRunner.set_permission_mode(mode: str) -> None`: validates mode ∈ {default, accept-edits, plan}, `await self.call("set_permission_mode", {"mode": mode})`, on success sets `self.permission_mode = mode`. Initial value `self.permission_mode: str = "default"`.
- `routes_coder`: `POST /conversations/{cid}/mode` body `{"mode": str}` → 200 `{"ok": true, "mode": mode}`; 400 `invalid_mode` for anything else (incl. `"yolo"` — explicit test); 409 `not_started` when no live runner. `_spawn` (create path only — NOT open) calls `await runner.set_permission_mode("default")` after `start()` succeeds; failure is non-fatal (log + continue: an old CLI at 1.10 rejects the method — the conversation still works at its persisted posture). `/turn` response gains `"mode": runner.permission_mode` (None-safe when runner absent).
- Preexec rlimits (both `wire_runner._preexec` and `pty_session._preexec_for_tty`): before the setgid/setuid calls, when `uid is not None` and the limit value > 0: `resource.setrlimit(resource.RLIMIT_NPROC, (n, n))` and `resource.setrlimit(resource.RLIMIT_FSIZE, (f, f))` wrapped in `try/except (ValueError, OSError): pass` (never break spawn on an unsupported platform — macOS dev). Values threaded from settings via new preexec parameters at both call sites.
- sanad-web proxy: NOT here — P2b adds `/api/coder/.../mode` with the switcher UI.

- [ ] **Step 1: Failing tests** — fake-wire handler for `set_permission_mode`; `test_wire_runner.py`: `test_call_round_trips` (call the fake's set_permission_mode, assert result), `test_set_permission_mode_updates_tracking` (CoderRunner, assert `.permission_mode` flips), `test_call_timeout_raises` (fake gets a `NOREPLY:set_permission_mode` mode? — simpler: call an unknown method the fake ignores entirely; use a 0.5s timeout override parameter on `call`); `test_routes_coder.py`: mode route happy path, `invalid_mode` on `"yolo"`, `not_started` on unknown cid, `/turn` carries `"mode"`, and create sets default (assert via `/turn` right after create). `test_settings.py`: rlimit envs parse with defaults.
- [ ] **Step 2: RED**, **Step 3: Implement**, **Step 4: GREEN + full suite** (`uv run pytest tests/ -q`).
- [ ] **Step 5: Commit** — message `sanad: mode route + default-mode seeding + agent rlimits — panel posture unlocked`.

---

## P2a exit criteria (spec traceability)

| Spec P2 item | Where |
|---|---|
| Trust hardening precedes lifting the all-gated force | Tasks 1–3 land before 7 (sequencing enforced by task order) |
| Root-owned trust store "behind agentd" — adapted: HMAC-signed + inline delivery (EFS uid mapping defeats file ownership; documented in module docstring) | Tasks 1–3 |
| `.sanad` carve-out (never auto-approvable, never cached) | Task 4 |
| Per-pattern shell approvals (+ legacy wildcard back-compat) | Task 4 |
| `set_permission_mode` + protocol 1.11 + StatusUpdate mode | Task 5 (+ snapshot re-record Task 6) |
| Modes default/accept-edits/plan unlocked; default seeded for new coder conversations; yolo rejected | Tasks 5+7 |
| Resource ulimits (nproc/fsize) on agent uid | Task 7 |

Not in P2a (P2b next: mode switcher UI, Shell/FileEdit/Search/Todo tool cards, DiffView extraction, `/api/coder/.../mode` proxy). Not in P2 at all: yolo, write-lease (P6), durable journal (P3).
