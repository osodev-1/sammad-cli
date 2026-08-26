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


def test_acquire_grants_but_flags_unpersisted_when_write_fails(
    session_dir: Path, monkeypatch: pytest.MonkeyPatch
):
    """C1: a write that can't land (e.g. the session dir not existing yet,
    which makes `atomic_json_write`'s mkstemp raise FileNotFoundError) must
    still fail OPEN — the caller is granted the lease, the session stays
    usable — but it must say so via `persisted=False` rather than silently
    promising a one-owner guarantee that never reached disk."""

    def raiser(_data: object, _path: Path) -> None:
        raise OSError("disk full")

    monkeypatch.setattr(sl, "atomic_json_write", raiser)
    result = sl.try_acquire(session_dir, holder="wire:a", ui_mode="wire", now=1000.0)
    assert result.ok is True
    assert result.owner is not None
    assert result.owner.holder == "wire:a"
    assert result.persisted is False

    # And the failure really did mean nothing landed on disk (the patched
    # writer only intercepts writes, so this read is unaffected by it).
    assert sl.read_owner(session_dir) is None


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
    assert result.reason is None
    assert result.persisted is True

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
    # I2: a genuine handoff is "taken", never conflated with "vanished".
    assert result.reason == "taken"


def test_heartbeat_surfaces_steal_requested_by(session_dir: Path):
    sl.try_acquire(session_dir, holder="wire:a", ui_mode="wire", now=1000.0)
    stole = sl.request_steal(session_dir, by="shell:b", now=1005.0)
    assert stole is True

    result = sl.heartbeat(session_dir, holder="wire:a", busy=False, now=1006.0)
    assert result.still_ours is True
    assert result.steal_requested_by == "shell:b"


def test_heartbeat_vanished_when_no_owner_can_be_read(tmp_path: Path):
    """A missing session dir means `read_owner` naturally returns None (no
    exception) — I2: this must read as "vanished", never "taken", since
    nobody actually holds the session."""
    ghost = tmp_path / "does" / "not" / "exist"
    result = sl.heartbeat(ghost, holder="wire:a", busy=False, now=1000.0)
    assert result.still_ours is False
    assert result.reason == "vanished"


def test_heartbeat_never_raises_on_unexpected_internal_failure(
    session_dir: Path, monkeypatch: pytest.MonkeyPatch
):
    """I4: the previous "missing session dir" test never actually reached
    the broad except guard, because `read_owner` already swallows OSError.
    Force a non-OSError out of `read_owner` to prove the guard itself works."""
    sl.try_acquire(session_dir, holder="wire:a", ui_mode="wire", now=1000.0)

    def boom(_session_dir: Path) -> sl.OwnerInfo | None:
        raise RuntimeError("boom")

    monkeypatch.setattr(sl, "read_owner", boom)
    result = sl.heartbeat(session_dir, holder="wire:a", busy=False, now=1000.0)
    assert result.still_ours is False
    assert result.reason == "vanished"


def test_heartbeat_reports_unpersisted_write_but_still_ours(
    session_dir: Path, monkeypatch: pytest.MonkeyPatch
):
    """M2: a heartbeat whose write can't land must not silently claim full
    success — `persisted=False` while `still_ours` stays True (we DID
    confirm we were still the recorded holder before the write failed)."""
    sl.try_acquire(session_dir, holder="wire:a", ui_mode="wire", now=1000.0)

    def raiser(_data: object, _path: Path) -> None:
        raise OSError("disk full")

    monkeypatch.setattr(sl, "atomic_json_write", raiser)
    result = sl.heartbeat(session_dir, holder="wire:a", busy=True, now=1010.0)
    assert result.still_ours is True
    assert result.persisted is False


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


def test_request_steal_false_when_write_fails(session_dir: Path, monkeypatch: pytest.MonkeyPatch):
    """I4: request_steal's False must also cover "the write itself couldn't
    land", not just "no live owner" — nothing was recorded either way."""
    sl.try_acquire(session_dir, holder="wire:a", ui_mode="wire", now=1000.0)

    def raiser(_data: object, _path: Path) -> None:
        raise OSError("disk full")

    monkeypatch.setattr(sl, "atomic_json_write", raiser)
    assert sl.request_steal(session_dir, by="shell:b", now=1005.0) is False


# ---------------------------------------------------------------------------
# release
# ---------------------------------------------------------------------------


def test_release_by_holder_frees_it(session_dir: Path):
    acquired = sl.try_acquire(session_dir, holder="wire:a", ui_mode="wire", now=1000.0)
    assert acquired.owner is not None
    sl.release(session_dir, holder="wire:a", generation=acquired.owner.generation)
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


def test_release_without_generation_falls_back_to_holder_only_check(session_dir: Path):
    """Omitting `generation` keeps the weaker holder-only guard (backward
    compatible) — same behavior as the original release() signature."""
    sl.try_acquire(session_dir, holder="wire:a", ui_mode="wire", now=1000.0)
    sl.release(session_dir, holder="wire:a")
    assert sl.read_owner(session_dir) is None


def test_release_with_mismatched_generation_is_a_noop(session_dir: Path):
    """I3: the SAME holder id can legitimately re-acquire (e.g. a
    reconnecting panel reusing its view id) between an earlier instance
    finishing and calling `release`. A stale release carrying the OLD
    generation must not tear down the new instance's lease — this is the
    gap a holder-only guard leaves open."""
    first = sl.try_acquire(session_dir, holder="wire:a", ui_mode="wire", now=1000.0)
    assert first.owner is not None
    stale_generation = first.owner.generation

    second = sl.try_acquire(session_dir, holder="wire:a", ui_mode="wire", now=1005.0)
    assert second.owner is not None
    assert second.owner.generation != stale_generation

    sl.release(session_dir, holder="wire:a", generation=stale_generation)

    owner = sl.read_owner(session_dir)
    assert owner is not None
    assert owner.generation == second.owner.generation


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
    assert acquire.persisted is True  # default, nothing was ever attempted

    assert sl.read_owner(session_dir) is None

    hb = sl.heartbeat(session_dir, holder="wire:a", busy=True, now=1000.0)
    assert hb.still_ours is True
    assert hb.steal_requested_by is None
    assert hb.reason is None
    assert hb.persisted is True

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


def test_write_leaves_no_tmp_file_observable(session_dir: Path):
    """No `.tmp` litter survives a write. (This alone doesn't prove the
    write was atomic — a hand-rolled `path.write_text(...)` would pass it
    too — see the next test for that property.)"""
    sl.try_acquire(session_dir, holder="wire:a", ui_mode="wire", now=1000.0)

    entries = list(session_dir.iterdir())
    assert entries == [session_dir / "owner.json"]
    for entry in entries:
        assert not entry.name.endswith(".tmp")

    owner = sl.read_owner(session_dir)
    assert owner is not None
    assert owner.holder == "wire:a"


def test_write_reuses_the_atomic_json_write_helper(
    session_dir: Path, monkeypatch: pytest.MonkeyPatch
):
    """I4: the previous test's "no .tmp litter" check is satisfied by a
    hand-rolled `write_text`, i.e. exactly the non-atomic implementation the
    brief forbids. Spy on `atomic_json_write` itself to prove this module
    genuinely delegates to the shared helper rather than re-implementing
    tmp+os.replace inline."""
    calls: list[Path] = []
    original = sl.atomic_json_write

    def spy(data: object, path: Path) -> None:
        calls.append(path)
        original(data, path)

    monkeypatch.setattr(sl, "atomic_json_write", spy)
    sl.try_acquire(session_dir, holder="wire:a", ui_mode="wire", now=1000.0)

    assert calls == [session_dir / "owner.json"]
