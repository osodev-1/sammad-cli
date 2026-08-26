"""P6b Task 1: the on-disk session lease primitive (`sanad/session_lock.py`).

Pure, synchronous, single-file (`owner.json`) — no asyncio. Every test injects
`now` so nothing here sleeps. `SANAD_SESSION_LOCKS` follows the
`activation.py` gating precedent: absent => every entry point no-ops
permissively and touches no disk, so local CLIs are byte-identical to before
this module existed.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from kimi_cli.sanad import session_lock as sl

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _locks_on(monkeypatch: pytest.MonkeyPatch):
    """Most tests exercise the lease itself, so gate it on by default."""
    monkeypatch.setenv("SANAD_SESSION_LOCKS", "1")


@pytest.fixture
def session_dir(tmp_path: Path) -> Path:
    d = tmp_path / "session"
    d.mkdir()
    return d


# ---------------------------------------------------------------------------
# locks_enabled
# ---------------------------------------------------------------------------


def test_locks_enabled_requires_exact_value_one(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("SANAD_SESSION_LOCKS", raising=False)
    assert sl.locks_enabled() is False

    monkeypatch.setenv("SANAD_SESSION_LOCKS", "true")
    assert sl.locks_enabled() is False

    monkeypatch.setenv("SANAD_SESSION_LOCKS", "1")
    assert sl.locks_enabled() is True


# ---------------------------------------------------------------------------
# try_acquire
# ---------------------------------------------------------------------------


def test_acquire_when_absent(session_dir: Path):
    result = sl.try_acquire(session_dir, holder="wire:a", ui_mode="wire", now=1000.0)
    assert result.ok is True
    assert result.owner is not None
    assert result.owner.holder == "wire:a"
    assert result.owner.ui_mode == "wire"
    assert result.owner.generation == 1
    assert result.owner.heartbeat_at == 1000.0
    assert result.owner.steal_requested_by is None
    assert result.owner.busy is False


def test_acquire_refused_by_live_foreign_owner(session_dir: Path):
    first = sl.try_acquire(session_dir, holder="wire:a", ui_mode="wire", now=1000.0)
    assert first.ok is True

    second = sl.try_acquire(session_dir, holder="shell:b", ui_mode="shell", now=1005.0)
    assert second.ok is False
    assert second.owner is not None
    assert second.owner.holder == "wire:a"
    assert second.owner.ui_mode == "wire"
    assert second.owner.busy is False


def test_acquire_refused_owner_carries_busy_flag(session_dir: Path):
    sl.try_acquire(session_dir, holder="wire:a", ui_mode="wire", now=1000.0)
    sl.heartbeat(session_dir, holder="wire:a", busy=True, now=1002.0)

    refused = sl.try_acquire(session_dir, holder="shell:b", ui_mode="shell", now=1003.0)
    assert refused.ok is False
    assert refused.owner is not None
    assert refused.owner.busy is True


def test_acquire_succeeds_when_owner_is_stale(session_dir: Path):
    sl.try_acquire(session_dir, holder="wire:a", ui_mode="wire", now=1000.0)

    # STALE_AFTER_SECONDS is 30.0 — 31s later the old owner is dead weight.
    taken = sl.try_acquire(session_dir, holder="shell:b", ui_mode="shell", now=1031.0)
    assert taken.ok is True
    assert taken.owner is not None
    assert taken.owner.holder == "shell:b"
    assert taken.owner.generation == 2


def test_reacquire_by_same_holder_is_idempotent_and_bumps_generation(session_dir: Path):
    first = sl.try_acquire(session_dir, holder="wire:a", ui_mode="wire", now=1000.0)
    assert first.owner is not None
    assert first.owner.generation == 1

    second = sl.try_acquire(session_dir, holder="wire:a", ui_mode="wire", now=1005.0)
    assert second.ok is True
    assert second.owner is not None
    assert second.owner.holder == "wire:a"
    assert second.owner.generation == 2

    third = sl.try_acquire(session_dir, holder="wire:a", ui_mode="wire", now=1010.0)
    assert third.ok is True
    assert third.owner is not None
    assert third.owner.generation == 3


# ---------------------------------------------------------------------------
# is_live
# ---------------------------------------------------------------------------


def test_is_live_boundary(session_dir: Path):
    acquired = sl.try_acquire(session_dir, holder="wire:a", ui_mode="wire", now=1000.0)
    owner = acquired.owner
    assert owner is not None

    assert sl.is_live(owner, now=1000.0) is True
    assert sl.is_live(owner, now=1029.9) is True
    assert sl.is_live(owner, now=1030.0) is False
    assert sl.is_live(owner, now=1031.0) is False


# ---------------------------------------------------------------------------
# heartbeat
# ---------------------------------------------------------------------------


def test_heartbeat_refreshes_when_still_ours(session_dir: Path):
    sl.try_acquire(session_dir, holder="wire:a", ui_mode="wire", now=1000.0)

    result = sl.heartbeat(session_dir, holder="wire:a", busy=True, now=1010.0)
    assert result.still_ours is True
    assert result.steal_requested_by is None

    owner = sl.read_owner(session_dir)
    assert owner is not None
    assert owner.heartbeat_at == 1010.0
    assert owner.busy is True


def test_heartbeat_not_ours_once_someone_else_holds_it(session_dir: Path):
    sl.try_acquire(session_dir, holder="wire:a", ui_mode="wire", now=1000.0)
    # Original owner goes stale; a second holder takes over.
    sl.try_acquire(session_dir, holder="shell:b", ui_mode="shell", now=1031.0)

    result = sl.heartbeat(session_dir, holder="wire:a", busy=False, now=1032.0)
    assert result.still_ours is False


def test_heartbeat_surfaces_steal_requested_by(session_dir: Path):
    sl.try_acquire(session_dir, holder="wire:a", ui_mode="wire", now=1000.0)
    stole = sl.request_steal(session_dir, by="shell:b", now=1005.0)
    assert stole is True

    result = sl.heartbeat(session_dir, holder="wire:a", busy=False, now=1006.0)
    assert result.still_ours is True
    assert result.steal_requested_by == "shell:b"


def test_heartbeat_never_raises_on_missing_session_dir(tmp_path: Path):
    ghost = tmp_path / "does" / "not" / "exist"
    result = sl.heartbeat(ghost, holder="wire:a", busy=False, now=1000.0)
    assert result.still_ours is False


# ---------------------------------------------------------------------------
# request_steal
# ---------------------------------------------------------------------------


def test_request_steal_sets_field_on_live_owner(session_dir: Path):
    sl.try_acquire(session_dir, holder="wire:a", ui_mode="wire", now=1000.0)
    assert sl.request_steal(session_dir, by="shell:b", now=1005.0) is True

    owner = sl.read_owner(session_dir)
    assert owner is not None
    assert owner.steal_requested_by == "shell:b"
    # holder/generation must survive the read-modify-write untouched.
    assert owner.holder == "wire:a"
    assert owner.generation == 1


def test_request_steal_false_when_no_live_owner(session_dir: Path):
    assert sl.request_steal(session_dir, by="shell:b", now=1000.0) is False

    sl.try_acquire(session_dir, holder="wire:a", ui_mode="wire", now=1000.0)
    # 31s later the owner above is stale => nothing live to steal from.
    assert sl.request_steal(session_dir, by="shell:b", now=1031.0) is False


# ---------------------------------------------------------------------------
# release
# ---------------------------------------------------------------------------


def test_release_by_holder_frees_it(session_dir: Path):
    sl.try_acquire(session_dir, holder="wire:a", ui_mode="wire", now=1000.0)
    sl.release(session_dir, holder="wire:a")
    assert sl.read_owner(session_dir) is None

    # A fresh acquire after release starts a clean lineage.
    result = sl.try_acquire(session_dir, holder="shell:b", ui_mode="shell", now=1001.0)
    assert result.ok is True
    assert result.owner is not None
    assert result.owner.generation == 1


def test_release_by_non_holder_is_a_noop(session_dir: Path):
    sl.try_acquire(session_dir, holder="wire:a", ui_mode="wire", now=1000.0)
    sl.release(session_dir, holder="shell:b")

    owner = sl.read_owner(session_dir)
    assert owner is not None
    assert owner.holder == "wire:a"


def test_release_when_nothing_owned_is_a_noop(session_dir: Path):
    sl.release(session_dir, holder="wire:a")
    assert sl.read_owner(session_dir) is None


# ---------------------------------------------------------------------------
# read_owner: fail open on corruption
# ---------------------------------------------------------------------------


def test_corrupt_owner_json_reads_as_none(session_dir: Path):
    (session_dir / "owner.json").write_text("{not valid json", encoding="utf-8")
    assert sl.read_owner(session_dir) is None


def test_malformed_owner_json_reads_as_none(session_dir: Path):
    (session_dir / "owner.json").write_text('{"holder": "wire:a"}', encoding="utf-8")
    assert sl.read_owner(session_dir) is None


def test_read_owner_absent_file_reads_as_none(session_dir: Path):
    assert sl.read_owner(session_dir) is None


# ---------------------------------------------------------------------------
# gate off: every entry point no-ops permissively and touches no disk
# ---------------------------------------------------------------------------


def test_gate_off_every_entry_point_is_a_permissive_noop(
    session_dir: Path, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.delenv("SANAD_SESSION_LOCKS", raising=False)

    acquire = sl.try_acquire(session_dir, holder="wire:a", ui_mode="wire", now=1000.0)
    assert acquire.ok is True
    assert acquire.owner is None

    assert sl.read_owner(session_dir) is None

    hb = sl.heartbeat(session_dir, holder="wire:a", busy=True, now=1000.0)
    assert hb.still_ours is True
    assert hb.steal_requested_by is None

    assert sl.request_steal(session_dir, by="shell:b", now=1000.0) is False

    sl.release(session_dir, holder="wire:a")  # must not raise

    # No owner.json was ever written to disk.
    assert not (session_dir / "owner.json").exists()
    assert list(session_dir.iterdir()) == []


def test_gate_off_does_not_disturb_a_preexisting_owner_file(
    session_dir: Path, monkeypatch: pytest.MonkeyPatch
):
    """If the gate flips off mid-flight, a stray owner.json is left alone,
    not deleted or rewritten — reading it just always comes back None."""
    sl.try_acquire(session_dir, holder="wire:a", ui_mode="wire", now=1000.0)
    monkeypatch.delenv("SANAD_SESSION_LOCKS", raising=False)

    assert sl.read_owner(session_dir) is None
    before = (session_dir / "owner.json").read_text(encoding="utf-8")

    sl.release(session_dir, holder="wire:a")

    after = (session_dir / "owner.json").read_text(encoding="utf-8")
    assert before == after


# ---------------------------------------------------------------------------
# atomic writes
# ---------------------------------------------------------------------------


def test_write_leaves_no_partial_file_observable(session_dir: Path):
    sl.try_acquire(session_dir, holder="wire:a", ui_mode="wire", now=1000.0)

    entries = list(session_dir.iterdir())
    assert entries == [session_dir / "owner.json"]
    for entry in entries:
        assert not entry.name.endswith(".tmp")

    owner = sl.read_owner(session_dir)
    assert owner is not None
    assert owner.holder == "wire:a"
