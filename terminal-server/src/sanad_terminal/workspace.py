"""Per-user directory layout and the agent's environment.

/data/users/<userId>/
  workspace/    agent cwd + file API root (the ONLY directory the API exposes)
  home/         $HOME for the agent process
  kimi-share/   $KIMI_SHARE_DIR (config.toml with minted tokens, sessions, logs)

kimi-share/ and home/ live OUTSIDE the file-API root by construction, so the
session token the CLI writes into config.toml is unreachable from the browser.
"""

from __future__ import annotations

import hashlib
import os
import re
from collections.abc import Sequence
from pathlib import Path

from sanad_terminal import session_owner

USER_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")


class InvalidUserId(ValueError):
    pass


def user_root(users_root: Path, user_id: str) -> Path:
    if not USER_ID_RE.fullmatch(user_id):
        raise InvalidUserId(f"invalid user id: {user_id!r}")
    return users_root / user_id


def prepare_user_dirs(users_root: Path, user_id: str) -> Path:
    """Create (idempotently) the user's directory triple; returns the root."""
    root = user_root(users_root, user_id)
    for name in ("workspace", "home", "kimi-share"):
        (root / name).mkdir(parents=True, exist_ok=True)
    root.chmod(0o700)
    return root


def workspace_dir(users_root: Path, user_id: str) -> Path:
    return user_root(users_root, user_id) / "workspace"


def kimi_share_dir(user_dir: Path) -> Path:
    """The `kimi-share/` sibling of a user/workspace root — where the CLI's
    `KIMI_SHARE_DIR` points (see `build_child_env`) and therefore where its
    `sessions/<digest>/<id>/owner.json` lease files live. `user_dir` is the
    triple's PARENT (workspace/home/kimi-share are siblings under it) —
    i.e. the same value `_journal_dir` calls `root.parent`."""
    return user_dir / "kimi-share"


def prepare_single_user_dirs(data_dir: Path) -> Path:
    """Task mode: ONE user per machine — the triple lives directly under /data.

    Same shape as the per-user dirs (workspace/home/kimi-share), no per-user
    nesting: the EFS access point already scopes the mount to this user.
    Returns data_dir (the "user dir" the rest of the code treats as root).
    """
    for name in ("workspace", "home", "kimi-share"):
        (data_dir / name).mkdir(parents=True, exist_ok=True)
    return data_dir


def find_resumable_session(
    kimi_share: Path, workspace: Path, *, locks_enabled: bool = False
) -> str | None:
    """Newest resumable session id for this workspace, or None.

    Mirrors the CLI's session layout: `<share>/sessions/<md5(workdir)>/<id>/`
    (the same convention tests/e2e/shell_pty_helpers.py::find_session_dir
    reproduces). Scanned from DISK, deliberately not from kimi.json's
    last_session_id — that pointer is only written on graceful exit, so an
    agent killed by a deploy or reap would leave it stale. The id is handed to
    `sanad run --resume <id>`, whose Session.find loads straight from disk and
    falls back to a fresh session instead of erroring (unlike --continue,
    which exits 2 when its metadata pointer is missing).

    `locks_enabled=False` (the default — "gate off") reproduces the
    ORIGINAL algorithm verbatim: a single linear max-scan over mtime, ties
    keeping the first-encountered candidate. `locks_enabled=True` (P6b)
    additionally walks candidates NEWEST FIRST and skips any with a LIVE
    session owner (`session_owner.read_owner`/`is_live`) — a session another
    view already holds must never be hijacked by a cold-start resume; if
    every candidate is locked, this returns None, which already degrades to
    the existing cold-start-fresh-session path (no new downstream code).
    """
    digest = hashlib.md5(str(workspace.resolve()).encode("utf-8")).hexdigest()
    sessions_root = kimi_share / "sessions" / digest
    if not sessions_root.is_dir():
        return None
    candidates: list[tuple[float, str]] = []
    for child in sessions_root.iterdir():
        context = child / "context.jsonl"
        try:
            stat = context.stat()
        except OSError:
            continue
        if stat.st_size <= 0:
            continue
        candidates.append((stat.st_mtime, child.name))
    if not candidates:
        return None

    if not locks_enabled:
        best = candidates[0]
        for cand in candidates[1:]:
            if cand[0] > best[0]:
                best = cand
        return best[1]

    for _, session_id in sorted(candidates, key=lambda c: c[0], reverse=True):
        owner = session_owner.read_owner(sessions_root / session_id)
        if owner is not None and session_owner.is_live(owner):
            continue  # live-owned elsewhere — never hijack it on cold start
        return session_id
    return None


def build_child_env(
    *,
    user_dir: Path,
    session_token: str,
    api_base_url: str,
    cols: int,
    rows: int,
    trusted_hashes: Sequence[str] | None = None,
    session_locks_enabled: bool = False,
) -> dict[str, str]:
    """The spawned agent's environment, built FROM SCRATCH.

    Never a copy of os.environ: the agent exposes a shell tool, so anything
    here is user-readable (`env`). TERMINAL_SHARED_SECRET must never appear.
    SANAD_SESSION_TOKEN is the user's own credential — acceptable by design.

    `session_locks_enabled` (P6b, default False — "gate off") threads
    `SANAD_SESSION_LOCKS` through to the child under the SAME env var name
    `kimi_cli.sanad.session_lock.locks_enabled()` reads, so agentd and the
    CLI it spawns always agree on whether the session lease is active.
    Omitted entirely (not `"0"`) when False, matching every existing call
    site that doesn't pass this parameter — the child env is byte-identical
    to before this parameter existed.
    """
    env = {
        "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
        "HOME": str(user_dir / "home"),
        "TERM": "xterm-256color",
        "COLUMNS": str(cols),
        "LINES": str(rows),
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "PYTHONUTF8": "1",
        "PROMPT_TOOLKIT_NO_CPR": "1",
        "KIMI_SHARE_DIR": str(user_dir / "kimi-share"),
        "KIMI_DISABLE_TELEMETRY": "1",
        "KIMI_CLI_NO_AUTO_UPDATE": "1",
        "SANAD_API_BASE_URL": api_base_url,
        "SANAD_SESSION_TOKEN": session_token,
    }
    if trusted_hashes is not None:
        # Inline delivery (P2a): the CLI gets the VERIFIED hash set at exec time
        # and never reads the store file — an in-session edit of the EFS store
        # can no longer poison gates (the signature check catches it at the
        # next spawn, and this process's set is already fixed).
        env["SANAD_BLUEPRINT_TRUST_SHA256S"] = ",".join(trusted_hashes)
    else:
        # S9 trust gate (legacy, pre-P2a callers): with this set, the CLI
        # loads `.sanad` skills only when their SKILL.md hash is recorded
        # here (apply-reviewed or UI-reviewed). Local dev CLIs never set it,
        # so their behavior is unchanged.
        env["SANAD_BLUEPRINT_TRUST"] = str(user_dir / "blueprint-trust.json")
    if session_locks_enabled:
        env["SANAD_SESSION_LOCKS"] = "1"
    return env


def verified_trust_hashes(workspace_root: Path, key: str) -> list[str]:
    """Sorted sha256 set from the signed store; [] when absent or tampered."""
    from sanad_terminal.blueprint_trust import load_trust_checked

    entries, tampered = load_trust_checked(workspace_root, key=key)
    if tampered:
        return []
    return sorted(
        e["sha256"] for e in entries.values() if isinstance(e.get("sha256"), str)
    )
