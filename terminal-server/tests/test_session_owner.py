"""`session_owner.py` unit + PARITY tests.

`sanad_terminal` does not import `kimi_cli` from its own production code
(one sanctioned exception elsewhere — see `pyproject.toml`) — but `kimi-cli`
IS a declared workspace dependency (co-installing the `sanad` console
script), so it IS importable here, and this TEST file deliberately does:
the whole point of a parity test is that a future change to the kimi-side
`owner.json` shape or digest rule breaks THIS test loudly, instead of the
two trees silently drifting apart.
"""

from __future__ import annotations

import dataclasses
import time
from pathlib import Path

import pytest
from sanad_terminal.session_owner import (
    LOCAL_KAOS_NAME,
    STALE_AFTER_SECONDS,
    OwnerInfo,
    is_live,
    read_owner,
    request_steal,
    session_dir_for,
)

from kimi_cli.metadata import WorkDirMeta
from kimi_cli.sanad.session_lock import STALE_AFTER_SECONDS as KIMI_STALE_AFTER_SECONDS
from kimi_cli.sanad.session_lock import OwnerInfo as KimiOwnerInfo
from kimi_cli.sanad.session_lock import try_acquire as kimi_try_acquire


@pytest.fixture(autouse=True)
def _kimi_locks_enabled(monkeypatch: pytest.MonkeyPatch):
    """Every real kimi-side call in this file (`try_acquire`/`heartbeat`)
    goes through `session_lock`'s OWN gate (`SANAD_SESSION_LOCKS`) — this
    whole file is specifically about exercising that gated on-disk format,
    so every test here needs it on. `session_owner.py`'s own functions are
    deliberately ungated (see its module docstring) — this fixture is
    ONLY about the kimi-side calls."""
    monkeypatch.setenv("SANAD_SESSION_LOCKS", "1")


# -- parity: shape ------------------------------------------------------------


def test_owner_info_field_shape_matches_kimi_side():
    """Same fields, in the same order, with the same defaults — this is
    what `dataclasses.asdict()` serializes on the kimi side and what our
    `_owner_from_json` decodes on this side. A future field added, renamed,
    or reordered on either side without a matching change on the other must
    fail HERE, not silently misread `owner.json` in production."""
    kimi_fields = [(f.name, f.default) for f in dataclasses.fields(KimiOwnerInfo)]
    ours = [(f.name, f.default) for f in dataclasses.fields(OwnerInfo)]
    assert ours == kimi_fields


def test_stale_after_seconds_matches_kimi_side():
    assert STALE_AFTER_SECONDS == KIMI_STALE_AFTER_SECONDS


# -- parity: the digest rule (session_dir_for) --------------------------------


def test_session_dir_for_matches_kimi_side_for_local_and_prefixed_kaos(tmp_path, monkeypatch):
    """Exercises the REAL `kimi_cli.metadata.WorkDirMeta.sessions_dir`
    property (not a hand-copied formula) for both the local (unprefixed)
    and kaos-prefixed digest branches — the exact branch
    `workspace.find_resumable_session` has always omitted."""
    kimi_share = tmp_path / "kimi-share"
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    monkeypatch.setenv("KIMI_SHARE_DIR", str(kimi_share))

    for kaos in (LOCAL_KAOS_NAME, "some-remote-kaos"):
        wd_meta = WorkDirMeta(path=str(workspace.resolve()), kaos=kaos)
        expected_sessions_dir = wd_meta.sessions_dir  # real kimi-side property; creates the dir
        ours = session_dir_for(kimi_share, workspace, "sess_1", kaos=kaos)
        assert ours.parent == expected_sessions_dir
        assert ours == expected_sessions_dir / "sess_1"


def test_session_dir_for_defaults_to_local_kaos(tmp_path):
    kimi_share = tmp_path / "kimi-share"
    workspace = tmp_path / "workspace"
    default = session_dir_for(kimi_share, workspace, "sess_1")
    explicit = session_dir_for(kimi_share, workspace, "sess_1", kaos=LOCAL_KAOS_NAME)
    assert default == explicit


# -- parity: real interop (kimi writes, we read; we write, kimi reads) --------


def test_read_owner_decodes_a_real_kimi_written_owner_file(tmp_path):
    """The strongest parity check: use the REAL kimi-side `try_acquire` to
    write `owner.json`, then confirm our independent reader decodes it into
    an equivalent `OwnerInfo`."""
    session_dir = tmp_path / "sess"
    session_dir.mkdir()
    now = time.time()
    result = kimi_try_acquire(session_dir, holder="wire:4242", ui_mode="wire", now=now)
    assert result.ok and result.persisted

    ours = read_owner(session_dir)
    assert ours is not None
    assert ours.holder == "wire:4242"
    assert ours.ui_mode == "wire"
    assert ours.generation == 1
    assert ours.heartbeat_at == now
    assert ours.steal_requested_by is None
    assert ours.busy is False


def test_kimi_heartbeat_sees_our_request_steal(tmp_path):
    """Interop the OTHER direction: OUR `request_steal` writes `owner.json`;
    the REAL kimi-side `heartbeat()` must read `steal_requested_by` back —
    proving our write format is byte-compatible with what the CLI actually
    reads, which is the whole justification for agentd writing this file at
    all (see the report's "is this write safe" discussion)."""
    from kimi_cli.sanad.session_lock import heartbeat as kimi_heartbeat

    session_dir = tmp_path / "sess"
    session_dir.mkdir()
    now = time.time()
    kimi_try_acquire(session_dir, holder="wire:99", ui_mode="wire", now=now)

    assert request_steal(session_dir, by="agentd:c_abc", now=now + 1) is True

    result = kimi_heartbeat(session_dir, holder="wire:99", busy=False, now=now + 2)
    assert result.still_ours is True
    assert result.steal_requested_by == "agentd:c_abc"


# -- read_owner / is_live: absent, corrupt, malformed --------------------------


def test_read_owner_missing_file_is_none(tmp_path: Path):
    assert read_owner(tmp_path / "no-such-session") is None


def test_read_owner_corrupt_json_is_none(tmp_path: Path):
    session_dir = tmp_path / "sess"
    session_dir.mkdir()
    (session_dir / "owner.json").write_text("{not json")
    assert read_owner(session_dir) is None


def test_read_owner_malformed_shape_is_none(tmp_path: Path):
    session_dir = tmp_path / "sess"
    session_dir.mkdir()
    (session_dir / "owner.json").write_text('{"holder": "wire:1", "pid": "not-an-int"}')
    assert read_owner(session_dir) is None


def test_is_live_true_within_window_false_after():
    owner = OwnerInfo(holder="wire:1", pid=1, ui_mode="wire", generation=1, heartbeat_at=1000.0)
    assert is_live(owner, now=1000.0 + STALE_AFTER_SECONDS - 1) is True
    assert is_live(owner, now=1000.0 + STALE_AFTER_SECONDS + 1) is False


# -- request_steal --------------------------------------------------------------


def test_request_steal_no_owner_returns_false(tmp_path: Path):
    session_dir = tmp_path / "sess"
    session_dir.mkdir()
    assert request_steal(session_dir, by="agentd:c_1") is False


def test_request_steal_stale_owner_returns_false(tmp_path: Path):
    session_dir = tmp_path / "sess"
    session_dir.mkdir()
    now = time.time()
    kimi_try_acquire(session_dir, holder="wire:1", ui_mode="wire", now=now - STALE_AFTER_SECONDS - 5)
    assert request_steal(session_dir, by="agentd:c_1", now=now) is False


def test_request_steal_sets_steal_requested_by_and_preserves_the_rest(tmp_path: Path):
    session_dir = tmp_path / "sess"
    session_dir.mkdir()
    now = time.time()
    kimi_try_acquire(session_dir, holder="wire:1", ui_mode="wire", now=now)
    assert request_steal(session_dir, by="agentd:c_1", now=now) is True

    owner = read_owner(session_dir)
    assert owner is not None
    assert owner.steal_requested_by == "agentd:c_1"
    assert owner.holder == "wire:1"  # untouched
    assert owner.busy is False  # untouched
