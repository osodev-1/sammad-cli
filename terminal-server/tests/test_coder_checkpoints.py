"""P5 Task 2 — CoderRunner checkpoint hooks: pre/post-turn snapshots chained
onto `GitRepo` (Task 1), journal SHAs + summary, `{kind:"checkpoint"}` follow
items, retention in lockstep with the durable journal, and best-effort
failure handling (a broken/missing repo must never fail a turn).

Every test drives the REAL `CoderJournal` + a real temp git repo (never a
mock) through the fake `sanad --wire` subprocess (`_fake_coder_wire.py`),
mirroring `test_coder_journal_recovery.py`'s construction style. A turn is
always awaited to full completion via its own consumer task (`runner.
_consumer`) rather than racing a live `follow()` against a still-running
turn: `_consume`'s `finally` (where the POST checkpoint is created) performs
real async git subprocess calls, so a `follow()` call that starts before the
turn is done could — absent the `TurnState.closed` fix this task also
needed — return before those calls land. Awaiting the consumer task first
sidesteps needing to time that race in a test; a *fresh* `follow()` call
afterward (as several tests do) is then guaranteed race-free (everything is
already appended by the time it starts draining).
"""

from __future__ import annotations

import asyncio
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest
from sanad_terminal.architect_runner import ArchitectRunner
from sanad_terminal.coder_journal import CoderJournal
from sanad_terminal.coder_runner import CoderRunner, new_conversation_id

pytestmark = pytest.mark.skipif(shutil.which("git") is None, reason="git not installed")

FAKE_CODER_WIRE = Path(__file__).parent / "_fake_coder_wire.py"
FAKE_ARCHITECT_WIRE = Path(__file__).parent / "_fake_architect_wire.py"


# -- git helpers (plain subprocess, mirrors test_git_checkpoints.py) --------


def _git(root: Path, *args: str) -> str:
    res = subprocess.run(
        ["git", "-C", str(root), *args], check=True, capture_output=True, text=True
    )
    return res.stdout


def _seed_repo(root: Path) -> None:
    root.mkdir(parents=True, exist_ok=True)
    _git(root, "init", "-q", "-b", "main")
    _git(root, "config", "user.name", "Test User")
    _git(root, "config", "user.email", "test@example.com")
    (root / "seed.txt").write_text("seed\n")
    _git(root, "add", "-A")
    _git(root, "commit", "-q", "-m", "seed")


def _ref_exists(root: Path, ref: str) -> bool:
    res = subprocess.run(
        ["git", "-C", str(root), "rev-parse", "--verify", "--quiet", ref],
        capture_output=True,
        text=True,
    )
    return res.returncode == 0


def _checkpoint_refs(root: Path, cid: str) -> set[str]:
    res = subprocess.run(
        ["git", "-C", str(root), "for-each-ref", "--format=%(refname)", f"refs/sanad/checkpoints/{cid}/"],
        capture_output=True,
        text=True,
    )
    return {line.strip() for line in res.stdout.splitlines() if line.strip()}


# -- CoderRunner helpers ------------------------------------------------------


def _make_runner(cwd: Path, journal_dir: Path, **kwargs: Any) -> CoderRunner:
    return CoderRunner(
        conversation_id=new_conversation_id(),
        argv=(sys.executable, str(FAKE_CODER_WIRE)),
        cwd=cwd,
        env={},
        max_turn_seconds=3600.0,
        max_steps_per_turn=200,
        journal_dir=journal_dir,
        **kwargs,
    )


async def _run_turn_to_completion(runner: CoderRunner, user_input: str, **kw: Any):
    """Start a turn and wait for its ENTIRE consumer chain — including
    CoderRunner's own `_consume` finally (checkpoint post, journal note,
    fsync, prune, queue drain) — to finish, not just for `status` to flip
    terminal. See the module docstring for why this matters here."""
    state = await runner.start_turn(user_input, **kw)
    consumer = runner._consumer
    assert consumer is not None
    await asyncio.wait_for(consumer, timeout=10.0)
    return state


async def _follow_all(runner: CoderRunner, turn_id: str) -> list[dict]:
    return [item async for item in runner.follow(turn_id, 0)]


def _load_index(journal_dir: Path, **kw: Any) -> list[dict]:
    journal = CoderJournal(journal_dir, turns_keep=kw.get("turns_keep", 20), max_bytes=20 * 1024 * 1024)
    index, _ = journal.load()
    return index


def _entry_for(index: list[dict], turn_id: str) -> dict:
    return next(e for e in index if e["turnId"] == turn_id)


# -- tests --------------------------------------------------------------------


@pytest.mark.asyncio
async def test_mutating_turn_records_pre_and_post_checkpoints_and_follow_items(tmp_path):
    workspace = tmp_path / "workspace"
    _seed_repo(workspace)
    journal_dir = tmp_path / "agentd" / "coder" / "c_mutate"

    runner = _make_runner(workspace, journal_dir)
    await runner.start()
    try:
        state = await _run_turn_to_completion(runner, "WRITEFILE:new.txt:hello\n")
        assert state.status == "finished"

        items = await _follow_all(runner, state.turn_id)
        checkpoint_items = [i for i in items if i.get("kind") == "checkpoint"]
        assert [i["when"] for i in checkpoint_items] == ["pre", "post"]
        pre_item, post_item = checkpoint_items
        assert isinstance(pre_item["sha"], str) and pre_item["sha"]
        assert isinstance(post_item["sha"], str) and post_item["sha"]
        assert post_item["sha"] != pre_item["sha"]
        assert post_item["summary"] == {"filesChanged": 1, "additions": 1, "deletions": 0}

        # The pre item lands right after "turn" (seq 0), before any wire
        # event — i.e. it really does represent the state as the turn began.
        assert items[0]["kind"] == "turn"
        assert items[1] == pre_item

        entry = _entry_for(_load_index(journal_dir), state.turn_id)
        assert entry["checkpointPre"] == pre_item["sha"]
        assert entry["checkpointPost"] == post_item["sha"]
        assert entry["checkpointSummary"] == {"filesChanged": 1, "additions": 1, "deletions": 0}

        # The checkpoint refs really exist in git, and the post commit's
        # content really is the new file.
        assert _ref_exists(workspace, f"refs/sanad/checkpoints/{runner.conversation_id}/{state.turn_id}-pre")
        assert _ref_exists(workspace, f"refs/sanad/checkpoints/{runner.conversation_id}/{state.turn_id}-post")
        assert _git(workspace, "show", f"{post_item['sha']}:new.txt") == "hello\n"
        with pytest.raises(subprocess.CalledProcessError):
            _git(workspace, "show", f"{pre_item['sha']}:new.txt")
    finally:
        await runner.stop()


@pytest.mark.asyncio
async def test_non_mutating_turn_records_pre_but_null_post(tmp_path):
    workspace = tmp_path / "workspace"
    _seed_repo(workspace)
    journal_dir = tmp_path / "agentd" / "coder" / "c_noop"

    runner = _make_runner(workspace, journal_dir)
    await runner.start()
    try:
        state = await _run_turn_to_completion(runner, "hello")  # default mode: no file writes
        assert state.status == "finished"

        items = await _follow_all(runner, state.turn_id)
        checkpoint_items = [i for i in items if i.get("kind") == "checkpoint"]
        assert [i["when"] for i in checkpoint_items] == ["pre", "post"]
        pre_item, post_item = checkpoint_items
        assert isinstance(pre_item["sha"], str) and pre_item["sha"]
        assert post_item["sha"] is None
        assert "summary" not in post_item

        entry = _entry_for(_load_index(journal_dir), state.turn_id)
        assert entry["checkpointPre"] == pre_item["sha"]
        assert entry["checkpointPost"] is None
        assert entry["checkpointSummary"] is None

        # No post ref was ever created — skip-when-clean creates nothing.
        assert not _ref_exists(
            workspace, f"refs/sanad/checkpoints/{runner.conversation_id}/{state.turn_id}-post"
        )
    finally:
        await runner.stop()


@pytest.mark.asyncio
async def test_checkpoint_creation_failure_does_not_fail_the_turn(tmp_path):
    """Point the runner at a workspace that is NOT a git repo — every
    `create_checkpoint` call raises `GitError`. The turn must still complete
    normally, with the failure caught, logged, and left as null checkpoints
    rather than propagated."""
    workspace = tmp_path / "workspace"
    workspace.mkdir(parents=True)  # exists, but `git init` never ran
    journal_dir = tmp_path / "agentd" / "coder" / "c_fail"

    runner = _make_runner(workspace, journal_dir)
    await runner.start()
    try:
        state = await _run_turn_to_completion(runner, "WRITEFILE:x.txt:content\n")
        assert state.status == "finished"  # the turn itself is entirely unaffected

        items = await _follow_all(runner, state.turn_id)
        assert [i.get("kind") for i in items].count("checkpoint") == 0
        assert items[-1]["kind"] == "end" and items[-1]["status"] == "finished"

        entry = _entry_for(_load_index(journal_dir), state.turn_id)
        assert entry["checkpointPre"] is None
        assert entry["checkpointPost"] is None
        assert entry["checkpointSummary"] is None

        # And a SECOND turn against the same still-broken repo behaves the
        # same way — the failure isn't a one-shot fluke or something that
        # wedges the runner.
        state2 = await _run_turn_to_completion(runner, "hello")
        assert state2.status == "finished"
    finally:
        await runner.stop()


@pytest.mark.asyncio
async def test_pre_checkpoint_chains_onto_the_previous_turns_post(tmp_path):
    """`_checkpoint_pre`'s `parent` is `_last_checkpoint_sha` (the previous
    turn's post-or-pre) — verified with an out-of-band edit between the two
    turns (mirrors a user editing a file via the workspace's own file API
    between turns) so turn 2's PRE snapshot genuinely differs from turn 1's
    POST and isn't itself skip-when-clean (which would otherwise make EVERY
    turn-after-the-first's pre null in the common case where nothing else
    touches the tree between turns — a real, spec-matching behavior, just
    not one that exercises actual git parent-chaining)."""
    workspace = tmp_path / "workspace"
    _seed_repo(workspace)
    journal_dir = tmp_path / "agentd" / "coder" / "c_chain"

    runner = _make_runner(workspace, journal_dir)
    await runner.start()
    try:
        state1 = await _run_turn_to_completion(runner, "WRITEFILE:a.txt:one\n")
        items1 = await _follow_all(runner, state1.turn_id)
        post1_sha = next(i["sha"] for i in items1 if i.get("kind") == "checkpoint" and i["when"] == "post")

        (workspace / "external.txt").write_text("out of band edit\n")

        state2 = await _run_turn_to_completion(runner, "WRITEFILE:b.txt:two\n")
        items2 = await _follow_all(runner, state2.turn_id)
        pre2_sha = next(i["sha"] for i in items2 if i.get("kind") == "checkpoint" and i["when"] == "pre")
        assert pre2_sha is not None

        parents = _git(workspace, "log", "-1", "--format=%P", pre2_sha).strip()
        assert parents == post1_sha
    finally:
        await runner.stop()


@pytest.mark.asyncio
async def test_pruning_drops_checkpoint_refs_beyond_journal_turns_keep(tmp_path):
    workspace = tmp_path / "workspace"
    _seed_repo(workspace)
    journal_dir = tmp_path / "agentd" / "coder" / "c_prune"

    runner = _make_runner(workspace, journal_dir, journal_turns_keep=2)
    await runner.start()
    try:
        turn_ids = []
        for n in range(4):
            # An out-of-band marker before each turn keeps every turn's OWN
            # pre checkpoint non-null (see test_pre_checkpoint_chains...'s
            # docstring) so this test exercises pruning of BOTH -pre and
            # -post refs, not just -post.
            (workspace / f"marker{n}.txt").write_text(f"marker-{n}\n")
            state = await _run_turn_to_completion(runner, f"WRITEFILE:f{n}.txt:content-{n}\n")
            turn_ids.append(state.turn_id)

        index = _load_index(journal_dir)
        kept_ids = {e["turnId"] for e in index}
        assert kept_ids == set(turn_ids[-2:])

        cid = runner.conversation_id
        remaining_refs = _checkpoint_refs(workspace, cid)
        for old_turn in turn_ids[:-2]:
            assert f"refs/sanad/checkpoints/{cid}/{old_turn}-pre" not in remaining_refs
            assert f"refs/sanad/checkpoints/{cid}/{old_turn}-post" not in remaining_refs
        for kept_turn in turn_ids[-2:]:
            assert f"refs/sanad/checkpoints/{cid}/{kept_turn}-pre" in remaining_refs
            assert f"refs/sanad/checkpoints/{cid}/{kept_turn}-post" in remaining_refs
    finally:
        await runner.stop()


@pytest.mark.asyncio
async def test_idempotent_resend_does_not_double_checkpoint(tmp_path):
    """`start_turn`'s own idempotency (same `send_id` while the turn is
    still current) must not re-checkpoint or re-chain — `_checkpoint_pre` is
    a no-op for a turn it already has a `_checkpoints` entry for."""
    workspace = tmp_path / "workspace"
    _seed_repo(workspace)
    journal_dir = tmp_path / "agentd" / "coder" / "c_resend"

    runner = _make_runner(workspace, journal_dir)
    await runner.start()
    try:
        state = await _run_turn_to_completion(runner, "WRITEFILE:a.txt:one\n", send_id="s1")
        # A resend of the SAME send_id after the turn already finished
        # returns the same (already-checkpointed) state without starting a
        # fresh turn.
        again = await runner.start_turn("WRITEFILE:a.txt:one\n", send_id="s1")
        assert again.turn_id == state.turn_id
        assert len([i for i in state.items if i.get("kind") == "checkpoint"]) == 2
    finally:
        await runner.stop()


@pytest.mark.asyncio
async def test_architect_runner_has_no_checkpoint_machinery(tmp_path):
    """ArchitectRunner shares WireRunner/TurnState with CoderRunner but must
    never grow checkpoint concerns — it extends WireRunner directly, not
    CoderRunner, so it structurally has none of the checkpoint machinery
    (`_checkpoints`, `_journal_entry`, a bound `GitRepo`) at all."""
    runner = ArchitectRunner(
        argv=(sys.executable, str(FAKE_ARCHITECT_WIRE)),
        cwd=tmp_path,
        env={},
    )
    await runner.start()
    try:
        state = await runner.start_turn("hello")
        items = [item async for item in runner.follow(state.turn_id, 0)]
        assert all(i.get("kind") != "checkpoint" for i in items)
        assert not hasattr(runner, "_checkpoints")
        assert not hasattr(runner, "_journal_entry")
        assert not hasattr(runner, "_git")
        # The turn's own summary (the closest thing architect has to a
        # journal entry) never carries checkpoint keys either.
        summary = state.summary()
        assert "checkpointPre" not in summary
        assert "checkpointPost" not in summary
    finally:
        await runner.stop()
