"""P6b Task 2: `Shell`/`WireServer` lease-tick wiring against REAL
`KimiSoul`/`Runtime` fixtures and real on-disk `owner.json` state — the
piece `test_session_lease_flow.py` deliberately leaves out (it proves the
same decision-to-disk sequence without needing Shell/WireServer at all).

`_lease_heartbeat_tick()` (NOT `_lease_heartbeat_loop()`) is awaited
directly in every test here — the loop wrapper's only job is `sleep; tick`,
and awaiting the real loop would mean a real `HEARTBEAT_SECONDS` (10s) wait
per test.
"""

from __future__ import annotations

import asyncio
import contextlib
from pathlib import Path
from typing import Any

import pytest
from kosong.tooling.empty import EmptyToolset

from kimi_cli.sanad import session_lease as sla
from kimi_cli.sanad import session_lock as sl
from kimi_cli.soul.agent import Agent, Runtime
from kimi_cli.soul.context import Context
from kimi_cli.soul.kimisoul import KimiSoul
from kimi_cli.ui.shell import Shell
from kimi_cli.ui.shell.prompt import _toast_queues
from kimi_cli.utils.aioqueue import Queue, QueueShutDown
from kimi_cli.wire.server import WireServer


@pytest.fixture(autouse=True)
def _locks_on(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("SANAD_SESSION_LOCKS", "1")


@pytest.fixture(autouse=True)
def _isolated_share_dir(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    """`session.dir` resolves through `get_share_dir()`, not `tmp_path`
    directly — redirect it so `.dir`'s `mkdir` never touches the real
    user share dir."""
    share_dir = tmp_path / "share"
    share_dir.mkdir()

    def _get_share_dir() -> Path:
        share_dir.mkdir(parents=True, exist_ok=True)
        return share_dir

    monkeypatch.setattr("kimi_cli.metadata.get_share_dir", _get_share_dir)
    return share_dir


@pytest.fixture
def soul(runtime: Runtime, tmp_path: Path) -> KimiSoul:
    agent = Agent(
        name="Test",
        system_prompt="test",
        toolset=EmptyToolset(),
        runtime=runtime,
    )
    return KimiSoul(agent, context=Context(file_backend=tmp_path / "history.jsonl"))


def _seed_lease(session_dir: Path, holder: str, ui_mode: sl.UiMode) -> sl.AcquireResult:
    acquired = sl.try_acquire(session_dir, holder=holder, ui_mode=ui_mode)
    assert acquired.ok
    assert acquired.owner is not None
    return acquired


# ---------------------------------------------------------------------------
# Shell
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_shell_start_lease_heartbeat_is_a_noop_when_lease_state_unset(soul: KimiSoul):
    """Gate-off (or gate-on but `run()` never ran) leaves `_lease_session_dir`
    None — `_start_lease_heartbeat` must start NO background task at all."""
    shell = Shell(soul)
    assert shell._lease_session_dir is None

    shell._start_lease_heartbeat()

    assert shell._background_tasks == set()


@pytest.mark.asyncio
async def test_shell_idle_holder_stands_down_releases_and_pushes_quit_event(
    soul: KimiSoul, runtime: Runtime
):
    shell = Shell(soul)
    session_dir = runtime.session.dir
    holder = sla.holder_id("shell")
    acquired = _seed_lease(session_dir, holder, "shell")
    assert acquired.owner is not None
    shell._lease_session_dir = session_dir
    shell._lease_holder = holder
    shell._lease_generation = acquired.owner.generation
    shell._idle_events = asyncio.Queue()

    taker = sla.holder_id("wire")
    assert sl.request_steal(session_dir, by=taker)

    # busy=False (default: no running turn) -> cooperative stand-down.
    action = await shell._lease_heartbeat_tick()

    assert action is sla.HeartbeatAction.STAND_DOWN
    # `_push_quit_event` put a quit event on the (now instance-level) queue.
    event = shell._idle_events.get_nowait()
    assert event.kind == "lease_taken_over"
    # NOTE: `_lease_heartbeat_tick` itself does not release — release is
    # `_release_lease()`'s job, called from `run()`'s `finally` once the
    # main loop actually breaks on that event. Confirm the owner is still
    # on record here (still "ours"), THEN confirm `_release_lease` frees it.
    owner_before_release = sl.read_owner(session_dir)
    assert owner_before_release is not None
    assert owner_before_release.holder == holder

    shell._release_lease()

    assert sl.read_owner(session_dir) is None


@pytest.mark.asyncio
async def test_shell_busy_holder_refuses_steal_and_clears_request_without_releasing(
    soul: KimiSoul, runtime: Runtime
):
    shell = Shell(soul)
    session_dir = runtime.session.dir
    holder = sla.holder_id("shell")
    acquired = _seed_lease(session_dir, holder, "shell")
    assert acquired.owner is not None
    shell._lease_session_dir = session_dir
    shell._lease_holder = holder
    shell._lease_generation = acquired.owner.generation

    def _mark_running() -> None:
        pass

    # `_running_interrupt_handler` bound == a turn is running (busy).
    shell._bind_running_input(lambda _user_input: None, _mark_running)

    taker = sla.holder_id("wire")
    assert sl.request_steal(session_dir, by=taker)

    action = await shell._lease_heartbeat_tick()

    assert action is sla.HeartbeatAction.REFUSE_STEAL
    owner = sl.read_owner(session_dir)
    assert owner is not None
    assert owner.holder == holder
    assert owner.steal_requested_by is None
    assert owner.generation > acquired.owner.generation
    assert shell._lease_generation == owner.generation


@pytest.mark.asyncio
async def test_shell_release_lease_is_a_noop_when_never_acquired(soul: KimiSoul):
    shell = Shell(soul)
    # Should not raise even though no lease state was ever set.
    shell._release_lease()


@pytest.mark.asyncio
async def test_shell_handle_root_hub_message_renders_notification_as_toast(soul: KimiSoul):
    """The plumbing gap the brief named explicitly:
    `_handle_root_hub_message` used to drop any non-Approval message. The
    lease heartbeat's stand-down path (`_publish_takeover_notification`)
    relies on THIS case to actually surface the "taken over" notice."""
    _toast_queues["left"].clear()
    try:
        shell = Shell(soul)
        notification = sla.build_takeover_notification(ui_mode="wire")

        await shell._handle_root_hub_message(notification)

        toasted = [entry.message for entry in _toast_queues["left"]]
        assert any(notification.body in message for message in toasted)
    finally:
        _toast_queues["left"].clear()


# ---------------------------------------------------------------------------
# WireServer
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_wire_start_lease_heartbeat_is_a_noop_when_gate_off(
    monkeypatch: pytest.MonkeyPatch, soul: KimiSoul
):
    monkeypatch.delenv("SANAD_SESSION_LOCKS", raising=False)
    server = WireServer(soul)

    server._start_lease_heartbeat()

    assert server._lease_task is None
    assert server._lease_session_dir is None


@pytest.mark.asyncio
async def test_wire_idle_holder_stands_down_sets_stop_event(soul: KimiSoul, runtime: Runtime):
    server = WireServer(soul)
    session_dir = runtime.session.dir
    holder = sla.holder_id("wire")
    acquired = _seed_lease(session_dir, holder, "wire")
    assert acquired.owner is not None
    server._lease_session_dir = session_dir
    server._lease_holder = holder
    server._lease_generation = acquired.owner.generation

    server._stop_event = asyncio.Event()

    taker = sla.holder_id("shell")
    assert sl.request_steal(session_dir, by=taker)

    action = await server._lease_heartbeat_tick()

    assert action is sla.HeartbeatAction.STAND_DOWN
    assert server._stop_event.is_set()


@pytest.mark.asyncio
async def test_wire_busy_holder_refuses_steal_and_clears_request(soul: KimiSoul, runtime: Runtime):
    server = WireServer(soul)
    session_dir = runtime.session.dir
    holder = sla.holder_id("wire")
    acquired = _seed_lease(session_dir, holder, "wire")
    assert acquired.owner is not None
    server._lease_session_dir = session_dir
    server._lease_holder = holder
    server._lease_generation = acquired.owner.generation
    # `_is_streaming` == `_cancel_event is not None`.
    server._cancel_event = asyncio.Event()
    server._stop_event = asyncio.Event()

    taker = sla.holder_id("shell")
    assert sl.request_steal(session_dir, by=taker)

    action = await server._lease_heartbeat_tick()

    assert action is sla.HeartbeatAction.REFUSE_STEAL
    assert not server._stop_event.is_set()
    owner = sl.read_owner(session_dir)
    assert owner is not None
    assert owner.holder == holder
    assert owner.steal_requested_by is None
    assert owner.generation > acquired.owner.generation


@pytest.mark.asyncio
async def test_wire_shutdown_releases_the_lease_on_normal_exit(soul: KimiSoul, runtime: Runtime):
    server = WireServer(soul)
    session_dir = runtime.session.dir
    holder = sla.holder_id("wire")
    acquired = _seed_lease(session_dir, holder, "wire")
    assert acquired.owner is not None
    server._lease_session_dir = session_dir
    server._lease_holder = holder
    server._lease_generation = acquired.owner.generation

    # `_shutdown()` also drains `_pending_requests`, closes the writer, etc.
    # None of those touch the lease block, but they DO need `_writer`/
    # `_write_task`/`_write_queue` to be in a shutdown-safe state — set up
    # the minimum `serve()` would have.
    server._write_queue = Queue()
    server._write_task = asyncio.create_task(_drain(server._write_queue))

    await server._shutdown()

    assert sl.read_owner(session_dir) is None


async def _drain(queue: Queue[Any]) -> None:
    with contextlib.suppress(QueueShutDown):
        while True:
            await queue.get()
