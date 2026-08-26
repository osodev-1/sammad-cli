# P6b locked decisions (Omar, 2026-08-26)

## 1. Takeover semantics: COOPERATIVE DETACH ("ask the holder to stand down")
The taker marks a steal request; the HOLDER notices on its next heartbeat (~10s),
finishes what it is mid-way through, saves state, and detaches cleanly with a
"taken over in the browser/terminal" message. Never a silent kill; no work can be
lost. Cost: a short wait, and BOTH sides need a detach path.

REJECTED: immediate seize (holder can be mid-turn/mid-write when it loses the
session); reclaim-only-if-stale (a TUI left open would block the user entirely,
and it contradicts the spec's locked "refuse + one-click takeover").

**HARD DEPENDENCY — verify in grounding section B before planning:** cooperative
detach is only implementable if BOTH sides can be told to stand down mid-session:
- panel/wire side: WireServer must be able to emit an out-of-band "taken over"
  event/error to the client AND shut down cleanly;
- TUI side: Shell must be interruptible/notifiable from a background heartbeat task.
If either mechanism is missing, STOP and take the tradeoff back to Omar rather than
silently degrading to an immediate seize.

## 2. Scope: LEASE FIRST, TABS AFTER
P6b = session lease + takeover UX + `find_resumable_session` lease filter, reusing
P6a's existing minimal ConversationSwitcher.
**P6c (separate later branch)** = full agent tabs (<=3 mounted-but-hidden like
MAX_TERMINALS), status badges/chips, the "+" popover, dock "Agents" section, and any
multi-conversation transcript persistence schema (P6a deliberately deferred that).

## Inherited context
- Base: main @ 23d4c06a (P0-P6a shipped; P6a closed the P5 revert TOCTOU).
- `session_lock.py` is 100% net-new; first real kimi-side work since P2a.
- Env-gate `SANAD_SESSION_LOCKS=1` following the `activation.py` precedent
  (absent => feature no-ops entirely so local CLIs are untouched).
- `find_resumable_session` is in terminal-server/workspace.py, NOT kimi-side
  (the spec is wrong on this) — sole caller is the PTY cold-start path.
- terminal-server does NOT import kimi_cli (one documented exception); reading
  owner.json from agentd is either a 2nd sanctioned exception or a reimplementation,
  exactly as find_resumable_session already reimplements the digest layout.
