"""CoderJournal unit tests — durable write sink, index, retention caps.

No FastAPI, no wire subprocess — pure filesystem behavior. This is P3
Task 1's write side only; reconstructing TurnStates from a loaded journal is
Task 2 and is NOT exercised here (``load()`` just returns raw data)."""

from __future__ import annotations

import json
import os
from pathlib import Path

from sanad_terminal.coder_journal import CoderJournal


def _read_ndjson(path: Path) -> list[dict]:
    items = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line:
            items.append(json.loads(line))
    return items


def test_init_creates_turns_dir(tmp_path):
    dir_path = tmp_path / "agentd" / "coder" / "c_abc"
    CoderJournal(dir_path, turns_keep=20, max_bytes=1024)
    assert (dir_path / "turns").is_dir()


def test_append_writes_ndjson_lines_with_seq_preserved(tmp_path):
    journal = CoderJournal(tmp_path, turns_keep=20, max_bytes=1_000_000)
    journal.append("t_1", {"seq": 0, "kind": "turn", "turnId": "t_1"})
    journal.append("t_1", {"seq": 1, "kind": "event", "event": {"type": "StepBegin"}})
    items = _read_ndjson(tmp_path / "turns" / "t_1.ndjson")
    assert items == [
        {"seq": 0, "kind": "turn", "turnId": "t_1"},
        {"seq": 1, "kind": "event", "event": {"type": "StepBegin"}},
    ]


def test_append_two_turns_load_returns_index_and_items_verbatim(tmp_path):
    journal = CoderJournal(tmp_path, turns_keep=20, max_bytes=1_000_000)
    journal.append("t_1", {"seq": 0, "kind": "turn", "turnId": "t_1"})
    journal.append("t_1", {"seq": 1, "kind": "end", "status": "finished"})
    journal.append("t_2", {"seq": 0, "kind": "turn", "turnId": "t_2"})
    journal.append("t_2", {"seq": 1, "kind": "end", "status": "cancelled"})

    index = [
        {"turnId": "t_1", "status": "finished", "sendId": None, "startedAt": 1.0, "lastSeq": 1},
        {"turnId": "t_2", "status": "cancelled", "sendId": "s1", "startedAt": 2.0, "lastSeq": 1},
    ]
    journal.write_index(index)

    loaded_index, items_by_turn = journal.load()
    assert loaded_index == index
    assert items_by_turn["t_1"] == [
        {"seq": 0, "kind": "turn", "turnId": "t_1"},
        {"seq": 1, "kind": "end", "status": "finished"},
    ]
    assert items_by_turn["t_2"] == [
        {"seq": 0, "kind": "turn", "turnId": "t_2"},
        {"seq": 1, "kind": "end", "status": "cancelled"},
    ]


def test_write_index_is_atomic_and_load_reads_it(tmp_path):
    journal = CoderJournal(tmp_path, turns_keep=20, max_bytes=1_000_000)
    turns = [{"turnId": "t_1", "status": "running", "sendId": None, "startedAt": 1.0, "lastSeq": 0}]
    journal.write_index(turns)

    index_path = tmp_path / "turns.json"
    assert index_path.is_file()
    # No leftover temp files from the tmp+os.replace dance.
    leftovers = [p for p in tmp_path.iterdir() if p.name != "turns.json" and p.name != "turns"]
    assert leftovers == []

    loaded_index, items_by_turn = journal.load()
    assert loaded_index == turns
    assert items_by_turn == {}  # no turn files referenced were written


def test_write_index_overwrites_previous_content(tmp_path):
    journal = CoderJournal(tmp_path, turns_keep=20, max_bytes=1_000_000)
    journal.write_index(
        [{"turnId": "t_1", "status": "running", "sendId": None, "startedAt": 1.0, "lastSeq": 0}]
    )
    journal.write_index(
        [{"turnId": "t_2", "status": "finished", "sendId": None, "startedAt": 2.0, "lastSeq": 0}]
    )
    loaded_index, _ = journal.load()
    assert loaded_index == [
        {"turnId": "t_2", "status": "finished", "sendId": None, "startedAt": 2.0, "lastSeq": 0}
    ]


def test_load_missing_index_returns_empty(tmp_path):
    journal = CoderJournal(tmp_path, turns_keep=20, max_bytes=1_000_000)
    index, items_by_turn = journal.load()
    assert index == []
    assert items_by_turn == {}


def test_load_corrupt_index_returns_empty(tmp_path):
    journal = CoderJournal(tmp_path, turns_keep=20, max_bytes=1_000_000)
    (tmp_path / "turns.json").write_text("{not json", encoding="utf-8")
    index, items_by_turn = journal.load()
    assert index == []
    assert items_by_turn == {}


def test_load_skips_corrupt_turn_file_but_keeps_others(tmp_path):
    journal = CoderJournal(tmp_path, turns_keep=20, max_bytes=1_000_000)
    journal.append("t_good", {"seq": 0, "kind": "turn", "turnId": "t_good"})
    (tmp_path / "turns" / "t_bad.ndjson").write_text("not-json-at-all\n", encoding="utf-8")
    index = [
        {"turnId": "t_good", "status": "finished", "sendId": None, "startedAt": 1.0, "lastSeq": 0},
        {"turnId": "t_bad", "status": "finished", "sendId": None, "startedAt": 2.0, "lastSeq": 0},
    ]
    journal.write_index(index)

    loaded_index, items_by_turn = journal.load()
    assert loaded_index == index
    assert "t_good" in items_by_turn
    assert "t_bad" not in items_by_turn


def test_load_skips_turn_referenced_in_index_but_missing_on_disk(tmp_path):
    journal = CoderJournal(tmp_path, turns_keep=20, max_bytes=1_000_000)
    index = [
        {"turnId": "t_ghost", "status": "finished", "sendId": None, "startedAt": 1.0, "lastSeq": 0}
    ]
    journal.write_index(index)
    loaded_index, items_by_turn = journal.load()
    assert loaded_index == index
    assert items_by_turn == {}


def test_prune_deletes_turn_files_not_kept(tmp_path):
    journal = CoderJournal(tmp_path, turns_keep=20, max_bytes=1_000_000)
    journal.append("t_1", {"seq": 0, "kind": "turn"})
    journal.append("t_2", {"seq": 0, "kind": "turn"})
    journal.append("t_3", {"seq": 0, "kind": "turn"})

    journal.prune(["t_2", "t_3"])

    turns_dir = tmp_path / "turns"
    remaining = {p.stem for p in turns_dir.glob("*.ndjson")}
    assert remaining == {"t_2", "t_3"}


def test_prune_is_a_noop_when_turns_dir_absent(tmp_path):
    journal = CoderJournal(tmp_path / "nope", turns_keep=20, max_bytes=1024)
    import shutil

    shutil.rmtree(tmp_path / "nope" / "turns")
    journal.prune(["anything"])  # must not raise


def test_fsync_turn_is_best_effort_and_does_not_raise(tmp_path):
    journal = CoderJournal(tmp_path, turns_keep=20, max_bytes=1024)
    journal.fsync_turn("does_not_exist")  # no file yet — must not raise
    journal.append("t_1", {"seq": 0, "kind": "turn"})
    journal.fsync_turn("t_1")  # must not raise


def test_overflow_journals_one_error_item_then_stops_growing(tmp_path):
    journal = CoderJournal(tmp_path, turns_keep=20, max_bytes=200)
    for i in range(200):
        journal.append("t_1", {"seq": i, "kind": "event", "payload": "x" * 20})

    items = _read_ndjson(tmp_path / "turns" / "t_1.ndjson")
    overflow_items = [i for i in items if i.get("code") == "journal_overflow"]
    assert len(overflow_items) == 1
    assert overflow_items[0]["kind"] == "error"

    size_after_first_overflow = (tmp_path / "turns" / "t_1.ndjson").stat().st_size

    # Further appends must not grow the file further (sentinel reached).
    journal.append("t_1", {"seq": 999, "kind": "event", "payload": "more"})
    journal.append("t_1", {"seq": 1000, "kind": "event", "payload": "more still"})
    assert (tmp_path / "turns" / "t_1.ndjson").stat().st_size == size_after_first_overflow


def test_overflow_on_one_turn_does_not_affect_another(tmp_path):
    journal = CoderJournal(tmp_path, turns_keep=20, max_bytes=200)
    for i in range(200):
        journal.append("t_overflow", {"seq": i, "kind": "event", "payload": "x" * 20})
    journal.append("t_fine", {"seq": 0, "kind": "turn", "turnId": "t_fine"})
    items = _read_ndjson(tmp_path / "turns" / "t_fine.ndjson")
    assert items == [{"seq": 0, "kind": "turn", "turnId": "t_fine"}]


def test_append_never_raises_on_unwritable_dir(tmp_path):
    dir_path = tmp_path / "locked"
    dir_path.mkdir()
    turns_dir = dir_path / "turns"
    turns_dir.mkdir()
    os.chmod(turns_dir, 0o400)  # read-only — writes inside must fail
    try:
        journal = CoderJournal(dir_path, turns_keep=20, max_bytes=1024)
        journal.append("t_1", {"seq": 0, "kind": "turn"})  # must not raise
    finally:
        os.chmod(turns_dir, 0o700)  # restore so tmp_path cleanup can delete it


def test_write_index_never_raises_on_unwritable_dir(tmp_path):
    dir_path = tmp_path / "locked2"
    dir_path.mkdir()
    os.chmod(dir_path, 0o500)  # read+exec only — can't create the tmp file
    try:
        journal = CoderJournal(dir_path, turns_keep=20, max_bytes=1024)
        journal.write_index([{"turnId": "t_1"}])  # must not raise
    finally:
        os.chmod(dir_path, 0o700)
