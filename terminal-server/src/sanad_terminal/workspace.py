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
from pathlib import Path

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


def has_previous_session(kimi_share: Path, workspace: Path) -> bool:
    """True when the CLI has a resumable session for this workspace.

    Mirrors the CLI's session layout: `<share>/sessions/<md5(workdir)>/<uuid>/`
    (the same convention tests/e2e/shell_pty_helpers.py::find_session_dir
    reproduces). A session is resumable when its context.jsonl has content —
    the CLI deletes empty sessions on exit, but be defensive anyway.
    """
    digest = hashlib.md5(str(workspace.resolve()).encode("utf-8")).hexdigest()
    sessions_root = kimi_share / "sessions" / digest
    if not sessions_root.is_dir():
        return False
    for child in sessions_root.iterdir():
        context = child / "context.jsonl"
        try:
            if context.is_file() and context.stat().st_size > 0:
                return True
        except OSError:
            continue
    return False


def build_child_env(
    *,
    user_dir: Path,
    session_token: str,
    api_base_url: str,
    cols: int,
    rows: int,
) -> dict[str, str]:
    """The spawned agent's environment, built FROM SCRATCH.

    Never a copy of os.environ: the agent exposes a shell tool, so anything
    here is user-readable (`env`). TERMINAL_SHARED_SECRET must never appear.
    SANAD_SESSION_TOKEN is the user's own credential — acceptable by design.
    """
    return {
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
