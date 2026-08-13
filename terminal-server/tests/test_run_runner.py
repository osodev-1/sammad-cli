import asyncio
import sys
from pathlib import Path

import pytest

from sanad_terminal.run_runner import (
    RUN_ID_RE, RunRunner, get_run, prepare_run_dirs, put_run,
)
from sanad_terminal.wire_runner import WireRunnerError

FAKE_WIRE = Path(__file__).parent / "_fake_worker_wire.py"


def _runner(tmp_path: Path, run_id: str = "r_aaaaaaaaaaaa") -> RunRunner:
    dirs = prepare_run_dirs(tmp_path, run_id)
    return RunRunner(
        run_id=run_id,
        argv=(sys.executable, str(FAKE_WIRE)),
        cwd=dirs.workspace,
        env={"KIMI_WORKER_OUTPUT_FILE": str(dirs.output_file)},
        uid=None, gid=None,
        max_turn_seconds=30.0, max_steps_per_turn=50, max_tokens_per_run=1000,
    )


def test_run_id_re() -> None:
    assert RUN_ID_RE.match("r_0123456789ab")
    assert not RUN_ID_RE.match("c_0123456789ab")
    assert not RUN_ID_RE.match("r_0123456789ABCD")


def test_prepare_run_dirs_layout(tmp_path: Path) -> None:
    dirs = prepare_run_dirs(tmp_path, "r_aaaaaaaaaaaa")
    assert dirs.root == tmp_path / "runs" / "r_aaaaaaaaaaaa"
    for d in (dirs.workspace, dirs.home, dirs.share, dirs.bundle):
        assert d.is_dir()
        assert (d.stat().st_mode & 0o777) == 0o700


async def test_exactly_one_turn(tmp_path: Path) -> None:
    runner = _runner(tmp_path)
    await runner.start()
    state = await runner.start_turn("go", send_id="s1")
    async for item in runner.follow(state.turn_id, 0):
        if item["kind"] in ("end", "error"):
            break
    with pytest.raises(WireRunnerError) as exc:
        await runner.start_turn("again", send_id="s2")
    assert exc.value.code == "run_consumed"
    await runner.stop()


async def test_same_send_id_replays(tmp_path: Path) -> None:
    runner = _runner(tmp_path)
    await runner.start()
    state = await runner.start_turn("go", send_id="s1")
    assert (await runner.start_turn("go", send_id="s1")).turn_id == state.turn_id
    await runner.stop()


async def test_token_budget_trips_and_journals(tmp_path: Path) -> None:
    """`observe_event` (the RunRunner override) sums StatusUpdate token_usage
    and, once the run's ceiling is exceeded, schedules the same `_trip_budget`
    the wall-clock/step watchers use — journaling a `turn_budget_exceeded`
    error and cancelling the turn."""
    run_id = "r_dddddddddddd"
    dirs = prepare_run_dirs(tmp_path, run_id)
    runner = RunRunner(
        run_id=run_id, argv=(sys.executable, str(FAKE_WIRE)),
        cwd=dirs.workspace, env={"KIMI_WORKER_OUTPUT_FILE": str(dirs.output_file)},
        uid=None, gid=None, max_turn_seconds=30.0, max_steps_per_turn=50,
        max_tokens_per_run=100,
    )
    await runner.start()
    state = await runner.start_turn("TOKENS:500")
    items = [item async for item in runner.follow(state.turn_id, 0)]
    codes = [i.get("code") for i in items if i.get("kind") == "error"]
    assert "turn_budget_exceeded" in codes
    assert state.status == "cancelled"
    totals = runner.usage_totals()
    assert totals["tokensOut"] == 500
    await runner.stop()


async def test_token_budget_does_not_corrupt_a_natural_finish(tmp_path: Path) -> None:
    """If the over-budget StatusUpdate is the run's LAST event before a
    natural `finished`, `_consume` can journal the `end` item and settle the
    turn in the same scheduling slice — before the trip task scheduled from
    that event ever gets a chance to run. `_schedule_trip`'s wrapper
    re-checks `state.status == "running"` as its first statement, so that
    late task must no-op instead of appending a stray `turn_budget_exceeded`
    error AFTER the turn already finished (which would corrupt
    `terminal_item()` for what was actually a successful run)."""
    run_id = "r_eeeeeeeeeeee"
    dirs = prepare_run_dirs(tmp_path, run_id)
    runner = RunRunner(
        run_id=run_id, argv=(sys.executable, str(FAKE_WIRE)),
        cwd=dirs.workspace, env={"KIMI_WORKER_OUTPUT_FILE": str(dirs.output_file)},
        uid=None, gid=None, max_turn_seconds=30.0, max_steps_per_turn=50,
        max_tokens_per_run=100,
    )
    await runner.start()
    state = await runner.start_turn("TOKENS_THEN_FINISH:500")
    async for item in runner.follow(state.turn_id, 0):
        if item["kind"] in ("end", "error"):
            break
    # Give any late-scheduled trip task its chance to run (and no-op) before
    # asserting the journal is settled.
    for _ in range(10):
        await asyncio.sleep(0)
    assert state.status == "finished"
    item = runner.terminal_item()
    assert item is not None
    assert item["kind"] == "end"
    codes = [i.get("code") for i in state.items if i.get("kind") == "error"]
    assert "turn_budget_exceeded" not in codes
    await runner.stop()


async def test_observe_event_ignores_malformed_token_usage(tmp_path: Path) -> None:
    """`observe_event` is telemetry parsing on subprocess-controlled data —
    it must degrade malformed fields to 0 (and never raise into `_consume`,
    which has no guard around this call)."""
    runner = _runner(tmp_path)
    runner.observe_event(
        {
            "type": "StatusUpdate",
            "payload": {"token_usage": {"input_other": "garbage", "output": [1]}},
        }
    )
    assert runner.usage_totals() == {"tokensIn": 0, "tokensOut": 0, "modelAlias": None}


async def test_on_finished_fires_once(tmp_path: Path) -> None:
    fired: list[str] = []

    async def on_finished(r: RunRunner) -> None:
        fired.append(r.run_id)

    dirs = prepare_run_dirs(tmp_path, "r_bbbbbbbbbbbb")
    runner = RunRunner(
        run_id="r_bbbbbbbbbbbb", argv=(sys.executable, str(FAKE_WIRE)),
        cwd=dirs.workspace, env={"KIMI_WORKER_OUTPUT_FILE": str(dirs.output_file)},
        uid=None, gid=None, max_turn_seconds=30.0, max_steps_per_turn=50,
        max_tokens_per_run=1000, on_finished=on_finished,
    )
    await runner.start()
    state = await runner.start_turn("go")
    async for item in runner.follow(state.turn_id, 0):
        if item["kind"] in ("end", "error"):
            break
    await runner.wait_finished_hooks()  # helper that awaits the callback task
    assert fired == ["r_bbbbbbbbbbbb"]
    await runner.stop()
