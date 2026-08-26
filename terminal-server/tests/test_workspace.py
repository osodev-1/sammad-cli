import os
from pathlib import Path

import pytest
from sanad_terminal.workspace import (
    InvalidUserId,
    build_child_env,
    prepare_user_dirs,
    workspace_dir,
)


@pytest.mark.parametrize("bad", ["", "../evil", "a/b", "a b", "x" * 129, ".", ".."])
def test_invalid_user_ids_rejected(tmp_path: Path, bad: str):
    with pytest.raises(InvalidUserId):
        prepare_user_dirs(tmp_path, bad)


def test_prepare_creates_triple_with_0700(tmp_path: Path):
    root = prepare_user_dirs(tmp_path, "user_3ABC")
    assert root == tmp_path / "user_3ABC"
    for name in ("workspace", "home", "kimi-share"):
        assert (root / name).is_dir()
    assert (root.stat().st_mode & 0o777) == 0o700
    # idempotent
    assert prepare_user_dirs(tmp_path, "user_3ABC") == root
    assert workspace_dir(tmp_path, "user_3ABC") == root / "workspace"


def test_child_env_exact_and_leak_free(tmp_path: Path, monkeypatch):
    """Exact dict equality proves nothing from os.environ leaks in —
    in particular TERMINAL_SHARED_SECRET."""
    monkeypatch.setenv("TERMINAL_SHARED_SECRET", "leaky")
    monkeypatch.setenv("SOME_RANDOM_VAR", "leaky-too")
    user_dir = prepare_user_dirs(tmp_path, "user_3ABC")

    env = build_child_env(
        user_dir=user_dir,
        session_token="sess_abc",
        api_base_url="https://cp.test",
        cols=120,
        rows=40,
    )

    assert env == {
        "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
        "HOME": str(user_dir / "home"),
        "TERM": "xterm-256color",
        "COLUMNS": "120",
        "LINES": "40",
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "PYTHONUTF8": "1",
        "PROMPT_TOOLKIT_NO_CPR": "1",
        "KIMI_SHARE_DIR": str(user_dir / "kimi-share"),
        "KIMI_DISABLE_TELEMETRY": "1",
        "KIMI_CLI_NO_AUTO_UPDATE": "1",
        "SANAD_API_BASE_URL": "https://cp.test",
        "SANAD_SESSION_TOKEN": "sess_abc",
        # S9: points the CLI's skill gate at the machine's trust store.
        "SANAD_BLUEPRINT_TRUST": str(user_dir / "blueprint-trust.json"),
    }


def test_session_locks_enabled_threads_the_env_var_into_the_child(tmp_path):
    """P6b: `SANAD_SESSION_LOCKS` reaches the child under the SAME name
    `kimi_cli.sanad.session_lock.locks_enabled()` reads, and ONLY when
    explicitly requested — the default (False, matching every existing call
    site) omits the key entirely, which is what
    `test_child_env_exact_and_leak_free` already pins."""
    env = build_child_env(
        user_dir=tmp_path, session_token="t", api_base_url="https://cp", cols=80, rows=24,
        session_locks_enabled=True,
    )
    assert env["SANAD_SESSION_LOCKS"] == "1"

    env_off = build_child_env(
        user_dir=tmp_path, session_token="t", api_base_url="https://cp", cols=80, rows=24,
        session_locks_enabled=False,
    )
    assert "SANAD_SESSION_LOCKS" not in env_off


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


def test_find_resumable_session(tmp_path: Path):
    import hashlib
    import os
    import time

    from sanad_terminal.workspace import find_resumable_session

    user_dir = prepare_user_dirs(tmp_path, "user_x")
    share = user_dir / "kimi-share"
    workspace = user_dir / "workspace"

    # Nothing yet
    assert find_resumable_session(share, workspace) is None

    digest = hashlib.md5(str(workspace.resolve()).encode("utf-8")).hexdigest()
    root = share / "sessions" / digest

    # Empty context → not resumable
    (root / "empty-sess").mkdir(parents=True)
    (root / "empty-sess" / "context.jsonl").write_text("")
    assert find_resumable_session(share, workspace) is None

    # Two real sessions → newest mtime wins
    (root / "older").mkdir()
    (root / "older" / "context.jsonl").write_text('{"role":"user"}\n')
    (root / "newer").mkdir()
    (root / "newer" / "context.jsonl").write_text('{"role":"user"}\n')
    past = time.time() - 100
    os.utime(root / "older" / "context.jsonl", (past, past))
    assert find_resumable_session(share, workspace) == "newer"


def _write_owner_file(session_dir: Path, *, holder: str, heartbeat_at: float) -> None:
    import json

    session_dir.mkdir(parents=True, exist_ok=True)
    (session_dir / "owner.json").write_text(
        json.dumps(
            {
                "holder": holder,
                "pid": 1,
                "ui_mode": "wire",
                "generation": 1,
                "heartbeat_at": heartbeat_at,
                "steal_requested_by": None,
                "busy": False,
            }
        )
    )


def test_find_resumable_session_gate_off_ignores_owner_files(tmp_path: Path):
    """Gate off (the default): behaviour identical to today — the newest
    mtime always wins regardless of any `owner.json` present."""
    import hashlib
    import os
    import time

    from sanad_terminal.workspace import find_resumable_session

    user_dir = prepare_user_dirs(tmp_path, "user_x")
    share = user_dir / "kimi-share"
    workspace = user_dir / "workspace"
    digest = hashlib.md5(str(workspace.resolve()).encode("utf-8")).hexdigest()
    root = share / "sessions" / digest

    (root / "older").mkdir(parents=True)
    (root / "older" / "context.jsonl").write_text('{"role":"user"}\n')
    (root / "newer").mkdir()
    (root / "newer" / "context.jsonl").write_text('{"role":"user"}\n')
    past = time.time() - 100
    os.utime(root / "older" / "context.jsonl", (past, past))
    _write_owner_file(root / "newer", holder="wire:1", heartbeat_at=time.time())

    assert find_resumable_session(share, workspace) == "newer"


def test_find_resumable_session_locks_enabled_skips_the_live_owned_newest(tmp_path: Path):
    import hashlib
    import os
    import time

    from sanad_terminal.workspace import find_resumable_session

    user_dir = prepare_user_dirs(tmp_path, "user_x")
    share = user_dir / "kimi-share"
    workspace = user_dir / "workspace"
    digest = hashlib.md5(str(workspace.resolve()).encode("utf-8")).hexdigest()
    root = share / "sessions" / digest

    (root / "older").mkdir(parents=True)
    (root / "older" / "context.jsonl").write_text('{"role":"user"}\n')
    (root / "newer").mkdir()
    (root / "newer" / "context.jsonl").write_text('{"role":"user"}\n')
    past = time.time() - 100
    os.utime(root / "older" / "context.jsonl", (past, past))
    _write_owner_file(root / "newer", holder="wire:1", heartbeat_at=time.time())

    # The newest session is LIVE-owned by someone else: skipped in favor of
    # the next-newest UNLOCKED candidate.
    assert find_resumable_session(share, workspace, locks_enabled=True) == "older"


def test_find_resumable_session_all_locked_returns_none(tmp_path: Path):
    import hashlib
    import time

    from sanad_terminal.workspace import find_resumable_session

    user_dir = prepare_user_dirs(tmp_path, "user_x")
    share = user_dir / "kimi-share"
    workspace = user_dir / "workspace"
    digest = hashlib.md5(str(workspace.resolve()).encode("utf-8")).hexdigest()
    root = share / "sessions" / digest

    for name in ("a", "b"):
        (root / name).mkdir(parents=True)
        (root / name / "context.jsonl").write_text('{"role":"user"}\n')
        _write_owner_file(root / name, holder=f"wire:{name}", heartbeat_at=time.time())

    assert find_resumable_session(share, workspace, locks_enabled=True) is None
    # All-locked degrades to the existing cold-start-fresh-session path —
    # no new downstream code; gate off is entirely unaffected regardless.
    assert find_resumable_session(share, workspace) in {"a", "b"}


def test_find_resumable_session_locks_enabled_stale_owner_is_not_live(tmp_path: Path):
    """A recorded owner whose heartbeat is older than STALE_AFTER_SECONDS
    doesn't count as live — the session stays resumable."""
    import hashlib
    import time

    from sanad_terminal.session_owner import STALE_AFTER_SECONDS
    from sanad_terminal.workspace import find_resumable_session

    user_dir = prepare_user_dirs(tmp_path, "user_x")
    share = user_dir / "kimi-share"
    workspace = user_dir / "workspace"
    digest = hashlib.md5(str(workspace.resolve()).encode("utf-8")).hexdigest()
    root = share / "sessions" / digest

    (root / "sess").mkdir(parents=True)
    (root / "sess" / "context.jsonl").write_text('{"role":"user"}\n')
    _write_owner_file(
        root / "sess", holder="wire:1", heartbeat_at=time.time() - STALE_AFTER_SECONDS - 5
    )

    assert find_resumable_session(share, workspace, locks_enabled=True) == "sess"
