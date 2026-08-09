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
