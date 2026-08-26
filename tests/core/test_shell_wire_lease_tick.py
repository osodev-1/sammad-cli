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
from kimi_cli.wire.jsonrpc import JSONRPCEventMessage
from kimi_cli.wire.server import WireServer
from kimi_cli.wire.types import Notification


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
async def test_shell_run_gate_off_never_touches_the_lease_at_all(
    monkeypatch: pytest.MonkeyPatch, soul: KimiSoul
):
    """Gate off ⇒ `run()` must never reach the lease layer AT ALL.

    The previous version of this test asserted `_lease_session_dir is None`
    and `_background_tasks == set()` AFTER `run()` returned — which the
    `finally` clears unconditionally, so it passed even with the
    `locks_enabled()` guard deleted (re-review caught it; verified by
    sabotage). Assert on the thing the `finally` cannot erase instead:
    that no lease entry point is ever CALLED. This ships in every local
    `sanad` install, so "the gate is off" has to mean untouched, not
    tidied-up-afterwards.
    """
    monkeypatch.delenv("SANAD_SESSION_LOCKS", raising=False)

    called: list[str] = []

    def _forbidden(name: str):
        def _fail(*_args: object, **_kwargs: object):
            called.append(name)
            raise AssertionError(f"{name} must not be called with the gate off")

        return _fail

    # Patch the names WHERE THE SHELL BOUND THEM. `ui.shell` does
    # `from ...session_lock import try_acquire, ...`, so those are module-level
    # names in `ui.shell`; patching `session_lock.try_acquire` would leave the
    # already-bound references untouched and this test would pass for the wrong
    # reason — the exact trap the version this replaces fell into.
    import kimi_cli.ui.shell as shell_mod

    for entry in ("try_acquire", "heartbeat", "release", "read_owner"):
        monkeypatch.setattr(shell_mod, entry, _forbidden(entry))

    shell = Shell(soul)

    async def _fake_run_soul_command(user_input: object) -> bool:
        return True

    monkeypatch.setattr(shell, "run_soul_command", _fake_run_soul_command)

    result = await shell.run(command="hi")

    assert result is True
    assert called == [], f"gate-off run touched the lease layer: {called}"
    # Belt-and-braces: the post-run state the old test checked, kept as a
    # secondary signal rather than the primary one.
    assert shell._lease_session_dir is None
    assert shell._lease_holder is None


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
async def test_shell_stand_down_before_idle_events_exists_keeps_heartbeat_alive(
    soul: KimiSoul, runtime: Runtime
):
    """Review fix (Critical 1): the interactive `run()` startup window
    (between `_start_lease_heartbeat()` and the loop that would consume
    `lease_taken_over` actually starting) used to be able to swallow a
    STAND_DOWN decision entirely — `_push_quit_event` found `_idle_events
    is None`, logged, and the OLD `_lease_heartbeat_loop` simply `return`ed,
    permanently abandoning the lease while the shell kept running and
    writing. Fixed at the source (idle_events now created before the
    heartbeat starts), but this pins the DEFENSIVE half: even if delivery
    fails, the tick must report CONTINUE (not STAND_DOWN) so the loop
    keeps beating — "heartbeat survives" — and `_lease_stood_down` must
    still be set so the belt-and-braces check in `run()`'s main loop can
    notice once it starts. Then, once the queue exists (the race window
    closing), the NEXT tick must actually deliver and stop the shell —
    "the shell still stops"."""
    shell = Shell(soul)
    session_dir = runtime.session.dir
    holder = sla.holder_id("shell")
    acquired = _seed_lease(session_dir, holder, "shell")
    assert acquired.owner is not None
    shell._lease_session_dir = session_dir
    shell._lease_holder = holder
    shell._lease_generation = acquired.owner.generation
    # Deliberately NOT set — simulates the startup race.
    assert shell._idle_events is None
    assert shell._lease_stood_down is False

    taker = sla.holder_id("wire")
    assert sl.request_steal(session_dir, by=taker)

    # Tick #1: STAND_DOWN was decided, but there's nowhere to deliver it.
    action = await shell._lease_heartbeat_tick()

    assert action is sla.HeartbeatAction.CONTINUE  # heartbeat survives
    assert shell._lease_stood_down is True  # belt-and-braces flag still set
    owner = sl.read_owner(session_dir)
    assert owner is not None
    assert owner.holder == holder  # still ours — nothing was released

    # The interactive loop starts (closing the race window in real code;
    # simulated here directly).
    shell._idle_events = asyncio.Queue()

    # Tick #2: now it can actually deliver and the shell stops.
    action = await shell._lease_heartbeat_tick()

    assert action is sla.HeartbeatAction.STAND_DOWN
    event = shell._idle_events.get_nowait()
    assert event.kind == "lease_taken_over"


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
async def test_shell_taken_while_busy_interrupts_the_running_turn(soul: KimiSoul, runtime: Runtime):
    """Review fix (Important 4): a `reason="taken"` stand-down (a genuine,
    non-cooperative loss via stale seizure — the only way STAND_DOWN can
    coincide with `busy=True`, since steal+busy is refused) must preempt
    the in-flight turn, mirroring what wire already does by setting
    `_cancel_event`. Shell's equivalent is `_running_interrupt_handler` —
    the same callback Ctrl-C uses."""
    shell = Shell(soul)
    session_dir = runtime.session.dir
    holder = sla.holder_id("shell")
    # Explicit synthetic `now`s (not real wall-clock time) so the seizure
    # below can see this acquire as stale without an actual 30s sleep —
    # same technique as test_session_lease_flow.py's stale-seizure test.
    now = 1_000_000.0
    acquired = sl.try_acquire(session_dir, holder=holder, ui_mode="shell", now=now)
    assert acquired.ok
    assert acquired.owner is not None
    shell._lease_session_dir = session_dir
    shell._lease_holder = holder
    shell._lease_generation = acquired.owner.generation
    shell._idle_events = asyncio.Queue()

    interrupted = False

    def _mark_interrupted() -> None:
        nonlocal interrupted
        interrupted = True

    shell._bind_running_input(lambda _user_input: None, _mark_interrupted)

    # A stale seizure: someone else's plain try_acquire took the (now
    # stale, from our point of view) lease outright — no steal request.
    # `_lease_heartbeat_tick`'s own `heartbeat()` call uses real wall-clock
    # time, but that's irrelevant here: "taken" is decided purely by
    # `current.holder != holder` on a direct read, not by staleness math.
    seizer = sla.holder_id("wire")
    later = now + sl.STALE_AFTER_SECONDS + 1
    seized = sl.try_acquire(session_dir, holder=seizer, ui_mode="wire", now=later)
    assert seized.ok

    action = await shell._lease_heartbeat_tick()

    assert action is sla.HeartbeatAction.STAND_DOWN
    assert interrupted is True
    event = shell._idle_events.get_nowait()
    assert event.kind == "lease_taken_over"


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


@pytest.mark.asyncio
async def test_wire_stand_down_notification_reaches_the_write_queue(
    soul: KimiSoul, runtime: Runtime
):
    """Review fix (M11): pins the claim in `_publish_takeover_notification`'s
    docstring — that `_root_hub_loop` forwards the notification to the
    client with no extra code — by actually running `_root_hub_loop` and
    checking what lands in `_write_queue`, instead of trusting the claim."""
    server = WireServer(soul)
    server._initialized = True
    assert isinstance(server._soul, KimiSoul)
    root_wire_hub = server._soul.runtime.root_wire_hub
    assert root_wire_hub is not None
    server._root_hub_queue = root_wire_hub.subscribe()
    server._root_hub_task = asyncio.create_task(server._root_hub_loop())
    server._write_queue = Queue()

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

    try:
        action = await server._lease_heartbeat_tick()
        assert action is sla.HeartbeatAction.STAND_DOWN

        msg = await asyncio.wait_for(server._write_queue.get(), timeout=1.0)
        assert isinstance(msg, JSONRPCEventMessage)
        assert isinstance(msg.params, Notification)
        assert "terminal" in msg.params.body
    finally:
        server._root_hub_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await server._root_hub_task
        root_wire_hub.unsubscribe(server._root_hub_queue)


@pytest.mark.asyncio
async def test_wire_refuse_steal_that_is_itself_refused_treats_it_as_stand_down(
    soul: KimiSoul, runtime: Runtime, monkeypatch: pytest.MonkeyPatch
):
    """Review fix (M10): if the self-reacquire inside REFUSE_STEAL is
    itself refused (a live, DIFFERENT holder is on record — the only way
    `try_acquire` ever refuses a self-reacquire), that must be treated as
    STAND_DOWN, not silently tracked as the other holder's generation.

    There is no `await` between `heartbeat()`'s read and the self-reacquire
    inside `_lease_heartbeat_tick`, so this TOCTOU race can't be reproduced
    with real timing from a test — `try_acquire` itself is monkeypatched
    for just this one call to return a refusal, decoupled from the real
    (still "ours", steal-requested) state `heartbeat()` reads first.
    """
    server = WireServer(soul)
    session_dir = runtime.session.dir
    holder = sla.holder_id("wire")
    acquired = _seed_lease(session_dir, holder, "wire")
    assert acquired.owner is not None
    server._lease_session_dir = session_dir
    server._lease_holder = holder
    server._lease_generation = acquired.owner.generation
    server._cancel_event = asyncio.Event()  # busy -> REFUSE_STEAL, not STAND_DOWN
    server._stop_event = asyncio.Event()

    taker = sla.holder_id("shell")
    assert sl.request_steal(session_dir, by=taker)

    other_owner = sl.OwnerInfo(
        holder="wire:999999",
        pid=999999,
        ui_mode="wire",
        generation=7,
        heartbeat_at=1_000_000.0,
    )
    reacquire_calls: list[str] = []

    def _fake_try_acquire(
        session_dir_arg: Path, *, holder: str, ui_mode: sl.UiMode, now: float | None = None
    ) -> sl.AcquireResult:
        reacquire_calls.append(holder)
        return sl.AcquireResult(ok=False, owner=other_owner)

    monkeypatch.setattr("kimi_cli.wire.server.try_acquire", _fake_try_acquire)

    action = await server._lease_heartbeat_tick()

    assert action is sla.HeartbeatAction.STAND_DOWN
    assert server._stop_event.is_set()
    assert reacquire_calls == [holder]
    # `_lease_generation` was NOT overwritten with the other holder's
    # value — the refused self-reacquire's branch never touches it.
    assert server._lease_generation == acquired.owner.generation
    assert server._lease_generation != other_owner.generation


async def _drain(queue: Queue[Any]) -> None:
    with contextlib.suppress(QueueShutDown):
        while True:
            await queue.get()
