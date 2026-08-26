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
from typing import get_args

import pytest
from sanad_terminal import session_owner as session_owner_module
from sanad_terminal.session_owner import (
    LOCAL_KAOS_NAME,
    STALE_AFTER_SECONDS,
    OwnerInfo,
    _write_owner,
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


def test_owner_info_field_types_match_kimi_side_too():
    """Important 5 (review): the shape test above pins names/order/defaults
    but NOT the annotation itself — a field silently retyped on one side
    (e.g. `pid: int` -> `pid: int | None`) without a matching change on the
    other would stay green there. Both modules use `from __future__ import
    annotations`, so `Field.type` is the literal annotation STRING as
    written in source (not a resolved type object) — still a meaningful
    compare, since both files spell their shared alias (`UiMode`)
    identically."""
    kimi_types = [(f.name, f.type) for f in dataclasses.fields(KimiOwnerInfo)]
    ours_types = [(f.name, f.type) for f in dataclasses.fields(OwnerInfo)]
    assert ours_types == kimi_types


def test_stale_after_seconds_matches_kimi_side():
    assert STALE_AFTER_SECONDS == KIMI_STALE_AFTER_SECONDS


def test_ui_modes_vocabulary_matches_kimi_side():
    """Important 5 (review): `session_owner._UI_MODES` is a hand-copied
    frozenset, and `_owner_from_json` rejects the WHOLE record for an
    unknown `ui_mode` — the day kimi adds a third mode, agentd's
    `read_owner` would return `None` for a valid, LIVE-held lease, and
    every consumer fails open in the WRONG direction (e.g.
    `find_resumable_session` would hand a live session to a PTY cold
    start). This is precisely the silent drift a parity test exists to
    make loud, so compare BOTH the runtime membership set AND
    `typing.get_args(UiMode)` on both sides — either the frozenset or the
    type alias itself drifting alone must fail here."""
    from kimi_cli.sanad.session_lock import _UI_MODES as kimi_ui_modes
    from kimi_cli.sanad.session_lock import UiMode as KimiUiMode

    assert kimi_ui_modes == session_owner_module._UI_MODES
    assert set(get_args(session_owner_module.UiMode)) == set(get_args(KimiUiMode))
    # And that the alias and the frozenset agree with EACH OTHER on our own
    # side too — the actual invariant `_owner_from_json`'s `in _UI_MODES`
    # check relies on holding.
    assert set(get_args(session_owner_module.UiMode)) == session_owner_module._UI_MODES


def test_is_live_matches_kimi_side_is_live_at_the_boundary():
    """M9 (review): pinning only the CONSTANT leaves the actual comparison
    (`<` vs `<=`, or an added condition like a pid check) unpinned — a
    kimi-side change there would stay green here. Compare
    `session_owner.is_live` against the REAL `kimi_cli.sanad.session_lock.
    is_live` directly, over the SAME timestamps, including exactly at the
    staleness boundary where a `<`-vs-`<=` drift would first show up."""
    from kimi_cli.sanad.session_lock import is_live as kimi_is_live

    heartbeat_at = 1_000_000.0
    ours = OwnerInfo(holder="wire:1", pid=1, ui_mode="wire", generation=1, heartbeat_at=heartbeat_at)
    kimi_owner = KimiOwnerInfo(
        holder="wire:1", pid=1, ui_mode="wire", generation=1, heartbeat_at=heartbeat_at
    )

    for now in (
        heartbeat_at,  # elapsed 0
        heartbeat_at + STALE_AFTER_SECONDS - 1,  # just inside
        heartbeat_at + STALE_AFTER_SECONDS,  # EXACTLY at the boundary
        heartbeat_at + STALE_AFTER_SECONDS + 1,  # just outside
    ):
        assert is_live(ours, now=now) == kimi_is_live(kimi_owner, now=now), now


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


def test_session_dir_for_defaults_to_the_real_kimi_side_local_kaos_sentinel(tmp_path, monkeypatch):
    """Fix (review): the previous version of this test compared
    `session_dir_for`'s own default parameter against `LOCAL_KAOS_NAME`
    explicitly — tautological (comparing the function to itself using its
    own default; Python's default-argument mechanics guarantee that
    trivially, and it would stay green even if `LOCAL_KAOS_NAME` were the
    WRONG sentinel, as long as both sides of the comparison used the same
    wrong value). Assert against the REAL kimi-side sentinel
    (`kaos.local.local_kaos.name`) instead, AND that calling with NO
    `kaos` kwarg at all produces the identical digest the real kimi-side
    `WorkDirMeta.sessions_dir` computes for its own local kaos."""
    from kaos.local import local_kaos

    assert local_kaos.name == LOCAL_KAOS_NAME

    kimi_share = tmp_path / "kimi-share"
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    monkeypatch.setenv("KIMI_SHARE_DIR", str(kimi_share))

    wd_meta = WorkDirMeta(path=str(workspace.resolve()), kaos=local_kaos.name)
    expected_sessions_dir = wd_meta.sessions_dir  # real kimi-side property; creates the dir

    default = session_dir_for(kimi_share, workspace, "sess_1")  # no `kaos` kwarg at all
    assert default == expected_sessions_dir / "sess_1"


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


# -- CRITICAL (review): chown before replace, under a uid split ---------------


def test_write_owner_chowns_the_temp_file_before_replace_when_uid_is_given(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """Under the deployed uid split, agentd runs as root and the CLI child
    (the lease holder) runs as `uid`/`gid`. Writing `owner.json` via plain
    `mkstemp` + `os.replace` with no chown leaves it `root:root 0600` —
    permanently unreadable to the very holder whose own heartbeat must read
    it back (the bug this fix closes). Mirrors
    `git_ops.GitRepo._new_scratch_index`: chown the temp file under the
    CURRENT identity, THEN replace it into place — so the file `owner.json`
    ends up as is already agent-owned. `os.chown` cannot be exercised for
    real in CI (no privilege to actually change ownership on most runners),
    so this monkeypatches it and asserts it fires, with the CONFIGURED
    uid/gid, on the temp path, strictly BEFORE `os.replace` swaps it into
    place."""
    session_dir = tmp_path / "sess"
    session_dir.mkdir()
    owner = OwnerInfo(holder="wire:1", pid=1, ui_mode="wire", generation=1, heartbeat_at=1.0)

    calls: list[tuple[str, object, object, object]] = []
    real_replace = session_owner_module.os.replace

    def fake_chown(path: object, uid: object, gid: object) -> None:
        calls.append(("chown", path, uid, gid))

    def fake_replace(src: str | Path, dst: str | Path) -> None:
        calls.append(("replace", src, dst, None))
        real_replace(src, dst)

    monkeypatch.setattr(session_owner_module.os, "chown", fake_chown)
    monkeypatch.setattr(session_owner_module.os, "replace", fake_replace)

    assert _write_owner(session_dir, owner, uid=4200, gid=4201) is True

    assert [c[0] for c in calls] == ["chown", "replace"]  # chown BEFORE replace
    chown_call, replace_call = calls
    assert chown_call[2:] == (4200, 4201)
    tmp_path_written = chown_call[1]
    assert replace_call[1] == tmp_path_written  # same temp file, then moved into place


def test_write_owner_chowns_with_gid_negative_one_when_gid_not_given(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """`gid=None` (uid-only configuration) must chown with `-1` for the
    group — `os.chown`'s documented "leave unchanged" sentinel — exactly
    the `self._gid if self._gid is not None else -1` fallback
    `git_ops.GitRepo._new_scratch_index` uses, NOT a raw `None` (which
    `os.chown` rejects with a TypeError)."""
    session_dir = tmp_path / "sess"
    session_dir.mkdir()
    owner = OwnerInfo(holder="wire:1", pid=1, ui_mode="wire", generation=1, heartbeat_at=1.0)

    calls: list[tuple[object, object]] = []
    monkeypatch.setattr(
        session_owner_module.os, "chown", lambda path, uid, gid: calls.append((uid, gid))
    )

    assert _write_owner(session_dir, owner, uid=4200, gid=None) is True
    assert calls == [(4200, -1)]


def test_write_owner_does_not_chown_when_uid_is_none(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """No uid split configured (the common local/dev case) => byte-identical
    to before this fix: `os.chown` must never be called at all."""
    session_dir = tmp_path / "sess"
    session_dir.mkdir()
    owner = OwnerInfo(holder="wire:1", pid=1, ui_mode="wire", generation=1, heartbeat_at=1.0)

    called = False

    def fake_chown(path: object, uid: object, gid: object) -> None:
        nonlocal called
        called = True

    monkeypatch.setattr(session_owner_module.os, "chown", fake_chown)

    assert _write_owner(session_dir, owner) is True
    assert called is False


def test_request_steal_threads_uid_gid_through_to_write_owner(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """`request_steal` is `routes_coder._handle_session_owned`'s only entry
    point into a write here — proves the `uid`/`gid` it is given actually
    reach `_write_owner`, not just that `_write_owner` itself honors them
    when called directly."""
    session_dir = tmp_path / "sess"
    session_dir.mkdir()
    now = time.time()
    kimi_try_acquire(session_dir, holder="wire:1", ui_mode="wire", now=now)

    seen: list[tuple[object, object]] = []

    def fake_write_owner(dir_: Path, owner: OwnerInfo, *, uid=None, gid=None) -> bool:
        seen.append((uid, gid))
        return True

    monkeypatch.setattr(session_owner_module, "_write_owner", fake_write_owner)

    assert request_steal(session_dir, by="agentd:c_1", now=now, uid=4200, gid=4201) is True
    assert seen == [(4200, 4201)]
