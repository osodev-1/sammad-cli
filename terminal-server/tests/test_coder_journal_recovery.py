"""P3 Task 2 — restart recovery: loading + reconciling the durable coder
journal on `CoderRunner` construction. Fixtures are written with the real
`CoderJournal` (no fake wire process is started — reconstruction is pure
construction-time logic, exercised without ever calling `.start()`)."""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest
from sanad_terminal.coder_journal import CoderJournal
from sanad_terminal.coder_runner import CoderRunner, new_conversation_id

FAKE_WIRE = Path(__file__).parent / "_fake_coder_wire.py"


def _make_runner(journal_dir: Path, tmp_path: Path) -> CoderRunner:
    return CoderRunner(
        conversation_id=new_conversation_id(),
        argv=(sys.executable, str(FAKE_WIRE)),
        cwd=tmp_path,
        env={},
        max_turn_seconds=3600.0,
        max_steps_per_turn=200,
        journal_dir=journal_dir,
    )


async def _drain(runner: CoderRunner, turn_id: str) -> list[dict]:
    return [item async for item in runner.follow(turn_id, 0)]


@pytest.mark.asyncio
async def test_finished_turn_reconstructs_and_follow_replays_and_returns(tmp_path):
    journal_dir = tmp_path / "agentd" / "coder" / "c_a"
    journal = CoderJournal(journal_dir, turns_keep=20, max_bytes=20 * 1024 * 1024)
    journal.append("t_1", {"seq": 0, "kind": "turn", "turnId": "t_1"})
    journal.append("t_1", {"seq": 1, "kind": "event", "event": {"type": "StepBegin"}})
    journal.append("t_1", {"seq": 2, "kind": "end", "status": "finished"})
    journal.write_index(
        [
            {
                "turnId": "t_1",
                "status": "finished",
                "sendId": "s1",
                "startedAt": 1.0,
                "lastSeq": 2,
                "userInput": "hello there",
            }
        ]
    )

    runner = _make_runner(journal_dir, tmp_path)
    state = runner.get_turn("t_1")
    assert state is not None
    assert state.status == "finished"
    assert state.user_input == "hello there"
    assert state.send_id == "s1"
    assert state.steps == 1

    items = await asyncio.wait_for(_drain(runner, "t_1"), timeout=5.0)
    assert [i["kind"] for i in items] == ["turn", "event", "end"]
    summary = runner.turn_summary()
    assert summary is not None
    assert summary["turnId"] == "t_1"


@pytest.mark.asyncio
async def test_running_turn_reconciles_to_interrupted_and_cancels_pending(tmp_path):
    journal_dir = tmp_path / "agentd" / "coder" / "c_b"
    journal = CoderJournal(journal_dir, turns_keep=20, max_bytes=20 * 1024 * 1024)
    journal.append("t_2", {"seq": 0, "kind": "turn", "turnId": "t_2"})
    journal.append(
        "t_2",
        {
            "seq": 1,
            "kind": "request",
            "requestType": "approval",
            "requestId": "req_1",
            "turnId": "t_2",
            "request": {"action": "run command"},
        },
    )
    journal.write_index(
        [
            {
                "turnId": "t_2",
                "status": "running",
                "sendId": None,
                "startedAt": 2.0,
                "lastSeq": 1,
                "userInput": "do a thing",
            }
        ]
    )

    runner = _make_runner(journal_dir, tmp_path)
    state = runner.get_turn("t_2")
    assert state is not None
    assert state.status == "interrupted"
    assert runner.pending_summaries() == []

    # follow() must not hang — the turn is already terminal in memory.
    items = await asyncio.wait_for(_drain(runner, "t_2"), timeout=5.0)
    kinds = [i["kind"] for i in items]
    assert kinds == ["turn", "request", "request_cancelled", "error", "end"]
    assert items[2]["requestId"] == "req_1"
    assert items[2]["reason"] == "interrupted_by_restart"
    assert items[3]["code"] == "interrupted_by_restart"
    assert items[4]["status"] == "interrupted"

    # Disk must mirror memory: the reconciliation was journaled, and the
    # index was rewritten so a future reconstruction sees a terminal turn.
    loaded_index, items_by_turn = journal.load()
    assert loaded_index[0]["turnId"] == "t_2"
    assert loaded_index[0]["status"] == "interrupted"
    assert [i["kind"] for i in items_by_turn["t_2"]] == kinds


@pytest.mark.asyncio
async def test_reconstruction_is_idempotent_across_restarts(tmp_path):
    journal_dir = tmp_path / "agentd" / "coder" / "c_c"
    journal = CoderJournal(journal_dir, turns_keep=20, max_bytes=20 * 1024 * 1024)
    journal.append("t_3", {"seq": 0, "kind": "turn", "turnId": "t_3"})
    journal.append(
        "t_3",
        {
            "seq": 1,
            "kind": "request",
            "requestType": "approval",
            "requestId": "req_9",
            "turnId": "t_3",
            "request": {"action": "run command"},
        },
    )
    journal.write_index(
        [
            {
                "turnId": "t_3",
                "status": "running",
                "sendId": None,
                "startedAt": 3.0,
                "lastSeq": 1,
                "userInput": "first boot",
            }
        ]
    )

    first = _make_runner(journal_dir, tmp_path)
    state = first.get_turn("t_3")
    assert state is not None
    assert state.status == "interrupted"

    turn_file = journal_dir / "turns" / "t_3.ndjson"
    index_file = journal_dir / "turns.json"
    content_after_first = turn_file.read_text(encoding="utf-8")
    index_after_first = index_file.read_text(encoding="utf-8")

    # A second construction over the now-reconciled journal (simulating a
    # second restart) must add nothing and leave everything terminal.
    second = _make_runner(journal_dir, tmp_path)
    state2 = second.get_turn("t_3")
    assert state2 is not None
    assert state2.status == "interrupted"
    assert second.pending_summaries() == []

    assert turn_file.read_text(encoding="utf-8") == content_after_first
    assert index_file.read_text(encoding="utf-8") == index_after_first

    items = await asyncio.wait_for(_drain(second, "t_3"), timeout=5.0)
    assert [i["kind"] for i in items] == ["turn", "request", "request_cancelled", "error", "end"]


@pytest.mark.asyncio
async def test_no_journal_dir_reconstructs_nothing(tmp_path):
    """`journal_dir=None` (architect posture, bare-runner tests) must stay a
    complete no-op — no reconstruction attempted, no behavior change."""
    runner = CoderRunner(
        conversation_id=new_conversation_id(),
        argv=(sys.executable, str(FAKE_WIRE)),
        cwd=tmp_path,
        env={},
        max_turn_seconds=3600.0,
        max_steps_per_turn=200,
    )
    assert runner.turn_summary() is None
    assert runner.pending_summaries() == []


@pytest.mark.asyncio
async def test_empty_journal_dir_reconstructs_nothing(tmp_path):
    """A freshly minted conversation (journal_dir given but nothing written
    yet — e.g. `/create`) must not crash on an empty/missing index."""
    journal_dir = tmp_path / "agentd" / "coder" / "c_empty"
    runner = _make_runner(journal_dir, tmp_path)
    assert runner.turn_summary() is None
    assert runner.pending_summaries() == []
