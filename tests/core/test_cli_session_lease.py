"""P6b Task 2: the session-lease acquire wired into `cli/__init__.py`'s
main flow, right after session resolution and BEFORE `KimiCLI.create()`.

`KimiCLI.create()` is always replaced with a fake in these tests — it is
the expensive setup (LLM, Runtime, agents, MCP) the lease exists to skip on
refusal, and driving it for real would need a working model config/network,
which is exactly what a refusal must NOT require. The fake records into
`observed` BEFORE raising, so reachability is checked directly against
`observed` rather than against `result.exception` — the CLI's own top-level
handler wraps any exception from `_reload_loop()` in `typer.Exit(code=1)
from exc`, so the ORIGINAL exception type does not survive as
`result.exception` unchanged.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from kaos.path import KaosPath
from typer.testing import CliRunner

from kimi_cli.cli import ExitCode, cli
from kimi_cli.sanad import session_lease
from kimi_cli.sanad import session_lock as sl
from kimi_cli.sanad.session_lock import OwnerInfo
from kimi_cli.session import Session

runner = CliRunner()


@pytest.fixture(autouse=True)
def _no_real_stderr_redirect(monkeypatch: pytest.MonkeyPatch) -> None:
    """`_run()` calls the real `redirect_stderr_to_logger()` right before
    `KimiCLI.create()` (twice, in fact — once more after it succeeds). That
    installs a PROCESS-GLOBAL, session-lifetime `StderrRedirector` singleton
    (dup's fd 2, spawns a drain thread) that is never fully torn back down
    by `restore_stderr()` (`_original_fd` stays set once captured), so it
    silently breaks any LATER test in the same pytest run that asserts on
    `capsys`-captured stderr via `kimi_cli.app`'s `_write_original_stderr` /
    `open_original_stderr()` (e.g. `test_shutdown_background_tasks.py`).
    That redirection has nothing to do with the session lease this file
    tests, so it is stubbed out here rather than actually exercised.
    """
    monkeypatch.setattr("kimi_cli.utils.logging.redirect_stderr_to_logger", lambda *a, **kw: None)


@pytest.fixture
def isolated_share_dir(monkeypatch, tmp_path: Path) -> Path:
    share_dir = tmp_path / "share"
    share_dir.mkdir()

    def _get_share_dir() -> Path:
        share_dir.mkdir(parents=True, exist_ok=True)
        return share_dir

    monkeypatch.setattr("kimi_cli.share.get_share_dir", _get_share_dir)
    monkeypatch.setattr("kimi_cli.metadata.get_share_dir", _get_share_dir)
    return share_dir


@pytest.fixture
def work_dir(tmp_path: Path) -> KaosPath:
    path = tmp_path / "work"
    path.mkdir()
    return KaosPath.unsafe_from_local_path(path)


class _ReachedKimiCLICreate(Exception):
    """Raised by the `KimiCLI.create` fake — a distinct type so a test can
    tell "this fake actually ran" apart from any other failure, even though
    the CLI's own top-level handler re-wraps it before it reaches
    `result.exception` (see module docstring)."""


def _stub_kimi_cli_create(monkeypatch: pytest.MonkeyPatch, *, observed: dict[str, object]) -> None:
    """Replace `KimiCLI.create` with a fake that records reachability into
    `observed` BEFORE raising, then always raises. `observed` is populated
    if and only if `KimiCLI.create()` was actually called.

    Raising (simulating a startup crash) makes `_reload_loop`'s own
    pre-existing empty-session cleanup run afterward — correct behaviour
    for a genuine crash of a session THIS process legitimately holds the
    lease for, but it means `owner.json` can legitimately be gone by the
    time `runner.invoke()` returns. So the owner snapshot is captured HERE,
    at call time, rather than re-read after the full CLI run.
    """

    async def _fake_create(session, **kwargs):  # noqa: ANN001, ANN003
        observed["session"] = session
        observed["owner_json_exists_at_create_time"] = (session.dir / "owner.json").exists()
        observed["owner_snapshot_at_create_time"] = sl.read_owner(session.dir)
        raise _ReachedKimiCLICreate

    monkeypatch.setattr("kimi_cli.app.KimiCLI.create", _fake_create)


# ---------------------------------------------------------------------------
# Gate OFF: byte-identical to today
# ---------------------------------------------------------------------------


def test_gate_off_creates_no_owner_json_and_still_reaches_kimicli_create(
    monkeypatch: pytest.MonkeyPatch, isolated_share_dir: Path, work_dir: KaosPath
) -> None:
    monkeypatch.delenv("SANAD_SESSION_LOCKS", raising=False)
    observed: dict[str, object] = {}
    _stub_kimi_cli_create(monkeypatch, observed=observed)

    # Default ui is "shell" — no --print/--wire/--acp flag needed.
    runner.invoke(cli, ["--work-dir", str(work_dir)])

    # KimiCLI.create() WAS reached (gate-off never refuses) ...
    assert "session" in observed, "KimiCLI.create() was never called"
    # ... and by the time it ran, no owner.json existed on disk at all.
    assert observed["owner_json_exists_at_create_time"] is False
    session = observed["session"]
    assert isinstance(session, Session)
    assert not (session.dir / "owner.json").exists()


# ---------------------------------------------------------------------------
# Gate ON: acquire before KimiCLI.create(), refusal short-circuits it
# ---------------------------------------------------------------------------


def test_second_shell_process_is_refused_before_kimicli_create(
    monkeypatch: pytest.MonkeyPatch, isolated_share_dir: Path, work_dir: KaosPath
) -> None:
    monkeypatch.setenv("SANAD_SESSION_LOCKS", "1")
    session = asyncio.run(Session.create(work_dir))

    # A different holder already live-owns this session — e.g. the browser
    # panel's agentd child.
    other_holder = "wire:999999"
    acquired = sl.try_acquire(session.dir, holder=other_holder, ui_mode="wire")
    assert acquired.ok
    assert acquired.owner is not None

    observed: dict[str, object] = {}
    _stub_kimi_cli_create(monkeypatch, observed=observed)

    result = runner.invoke(cli, ["--work-dir", str(work_dir), "--session", session.id])

    # KimiCLI.create() must NEVER run.
    assert "session" not in observed, "KimiCLI.create() ran despite a live foreign owner"
    assert result.exit_code == ExitCode.SESSION_OWNED

    # The lease is untouched by the refused process — still the original
    # live holder, unchanged generation. In particular, the refused
    # process's own empty-session cleanup must NOT have deleted the other
    # view's session directory (and its owner.json) out from under it.
    owner = sl.read_owner(session.dir)
    assert owner is not None
    assert owner.holder == other_holder
    assert owner.generation == acquired.owner.generation


def test_shell_refusal_calls_emit_fatal_error_with_the_refusal_message(
    monkeypatch: pytest.MonkeyPatch, isolated_share_dir: Path, work_dir: KaosPath
) -> None:
    """`_emit_fatal_error` is a closure nested inside the `kimi()` Typer
    callback (not a module attribute), and its own output destination
    depends on `kimi_cli.utils.logging`'s process-global, test-order-
    dependent `_stderr_redirector` singleton — not something worth pinning
    down here. So this patches one level up: `session_lease.
    build_shell_refusal_message`, whose exact TEXT is already covered with
    no I/O at all in test_session_lease.py. This just proves the refusal
    branch actually calls it (with the right owner) and surfaces whatever
    it returns as the fatal error, rather than silently swallowing it."""
    monkeypatch.setenv("SANAD_SESSION_LOCKS", "1")
    session = asyncio.run(Session.create(work_dir))
    other_holder = "wire:999999"
    sl.try_acquire(session.dir, holder=other_holder, ui_mode="wire")

    sentinel = "SENTINEL: another view holds this session"
    calls: list[object] = []
    monkeypatch.setattr(
        "kimi_cli.sanad.session_lease.build_shell_refusal_message",
        lambda owner: (calls.append(owner), sentinel)[1],
    )
    observed: dict[str, object] = {}
    _stub_kimi_cli_create(monkeypatch, observed=observed)

    result = runner.invoke(cli, ["--work-dir", str(work_dir), "--session", session.id])

    assert "session" not in observed
    assert result.exit_code == ExitCode.SESSION_OWNED
    assert len(calls) == 1
    assert isinstance(calls[0], OwnerInfo)
    assert calls[0].holder == other_holder


def test_free_session_is_granted_and_reaches_kimicli_create(
    monkeypatch: pytest.MonkeyPatch, isolated_share_dir: Path, work_dir: KaosPath
) -> None:
    monkeypatch.setenv("SANAD_SESSION_LOCKS", "1")
    observed: dict[str, object] = {}
    _stub_kimi_cli_create(monkeypatch, observed=observed)

    runner.invoke(cli, ["--work-dir", str(work_dir)])

    assert "session" in observed
    owner = observed["owner_snapshot_at_create_time"]
    assert isinstance(owner, OwnerInfo)
    assert owner.ui_mode == "shell"
    assert owner.holder == session_lease.holder_id("shell")


# ---------------------------------------------------------------------------
# Wire mode: refusal goes through `refuse_wire_initialize`, not stderr
# ---------------------------------------------------------------------------


def test_wire_refusal_calls_refuse_wire_initialize_with_the_live_owner(
    monkeypatch: pytest.MonkeyPatch, isolated_share_dir: Path, work_dir: KaosPath
) -> None:
    """Proves the CLI's wire-mode refusal branch is reached with the right
    owner, WITHOUT driving real stdio (`refuse_wire_initialize`'s own shape
    is covered directly, with no I/O, by `build_session_owned_error` /
    `parse_initialize_request_id` in test_session_lease.py)."""
    monkeypatch.setenv("SANAD_SESSION_LOCKS", "1")
    session = asyncio.run(Session.create(work_dir))
    other_holder = "shell:123456"
    acquired = sl.try_acquire(session.dir, holder=other_holder, ui_mode="shell")
    assert acquired.ok

    refuse_calls: list[object] = []

    async def _fake_refuse_wire_initialize(owner):  # noqa: ANN001
        refuse_calls.append(owner)

    monkeypatch.setattr(
        "kimi_cli.sanad.session_lease.refuse_wire_initialize", _fake_refuse_wire_initialize
    )
    observed: dict[str, object] = {}
    _stub_kimi_cli_create(monkeypatch, observed=observed)

    result = runner.invoke(cli, ["--work-dir", str(work_dir), "--session", session.id, "--wire"])

    assert "session" not in observed
    assert result.exit_code == ExitCode.SESSION_OWNED
    assert len(refuse_calls) == 1
    assert isinstance(refuse_calls[0], OwnerInfo)
    assert refuse_calls[0].holder == other_holder
    assert refuse_calls[0].ui_mode == "shell"


def test_wire_gate_off_does_not_call_refuse_and_reaches_kimicli_create(
    monkeypatch: pytest.MonkeyPatch, isolated_share_dir: Path, work_dir: KaosPath
) -> None:
    monkeypatch.delenv("SANAD_SESSION_LOCKS", raising=False)
    refuse_calls: list[object] = []

    async def _fake_refuse_wire_initialize(owner):  # noqa: ANN001
        refuse_calls.append(owner)

    monkeypatch.setattr(
        "kimi_cli.sanad.session_lease.refuse_wire_initialize", _fake_refuse_wire_initialize
    )
    observed: dict[str, object] = {}
    _stub_kimi_cli_create(monkeypatch, observed=observed)

    runner.invoke(cli, ["--work-dir", str(work_dir), "--wire"])

    assert "session" in observed
    assert refuse_calls == []
