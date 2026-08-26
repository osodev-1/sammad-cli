"""P6b Task 2: the pure CLI-side lease-orchestration helpers
(`sanad/session_lease.py`).

Everything here is pure/synchronous — no asyncio, no disk I/O, no fixtures
from `session_lock.py`'s own test file. This is deliberate: the heartbeat
decision matrix is the actual product behaviour (see
`.superpowers/sdd/P6B-DECISIONS.md` decisions 1 and 2) and must be testable
directly, not only reachable through the wire/shell async loops that call it.
"""

from __future__ import annotations

import json

from kimi_cli.sanad import session_lease as sla
from kimi_cli.sanad.session_lock import HeartbeatResult, OwnerInfo
from kimi_cli.wire.jsonrpc import (
    ErrorCodes,
    JSONRPCErrorResponse,
    JSONRPCErrorResponseNullableID,
)

# ---------------------------------------------------------------------------
# holder_id
# ---------------------------------------------------------------------------


def test_holder_id_includes_ui_mode_and_pid():
    import os

    holder = sla.holder_id("wire")
    assert holder == f"wire:{os.getpid()}"


def test_holder_id_distinguishes_ui_modes_for_the_same_process():
    # Same process (same pid) but two different views must never collide.
    assert sla.holder_id("wire") != sla.holder_id("shell")


# ---------------------------------------------------------------------------
# decide_heartbeat_action — the full matrix
# ---------------------------------------------------------------------------


def _result(
    *, still_ours: bool, steal_requested_by: str | None = None, reason=None
) -> HeartbeatResult:
    return HeartbeatResult(still_ours=still_ours, steal_requested_by=steal_requested_by, reason=reason)


def test_taken_stands_down_even_if_we_are_busy():
    # A live, DIFFERENT holder is on record: we genuinely lost the lease.
    # This is NOT the cooperative-steal path — no busy check applies.
    result = _result(still_ours=False, reason="taken")
    assert sla.decide_heartbeat_action(result, busy=True) is sla.HeartbeatAction.STAND_DOWN
    assert sla.decide_heartbeat_action(result, busy=False) is sla.HeartbeatAction.STAND_DOWN


def test_vanished_never_stands_down_fail_open():
    # Nothing readable — corrupt/missing/unreadable owner.json, or an
    # unexpected internal heartbeat() failure. NOT an eviction.
    result = _result(still_ours=False, reason="vanished")
    assert sla.decide_heartbeat_action(result, busy=True) is sla.HeartbeatAction.CONTINUE
    assert sla.decide_heartbeat_action(result, busy=False) is sla.HeartbeatAction.CONTINUE


def test_still_ours_no_steal_continues():
    result = _result(still_ours=True, steal_requested_by=None)
    assert sla.decide_heartbeat_action(result, busy=True) is sla.HeartbeatAction.CONTINUE
    assert sla.decide_heartbeat_action(result, busy=False) is sla.HeartbeatAction.CONTINUE


def test_steal_requested_while_idle_stands_down():
    # Decision 1: cooperative detach.
    result = _result(still_ours=True, steal_requested_by="wire:999")
    assert sla.decide_heartbeat_action(result, busy=False) is sla.HeartbeatAction.STAND_DOWN


def test_steal_requested_while_busy_refuses():
    # Decision 2: a mid-turn takeover is refused, never queued.
    result = _result(still_ours=True, steal_requested_by="wire:999")
    assert sla.decide_heartbeat_action(result, busy=True) is sla.HeartbeatAction.REFUSE_STEAL


# ---------------------------------------------------------------------------
# should_warn_persist_failure (Important 4, review)
# ---------------------------------------------------------------------------


def test_should_warn_persist_failure_fires_on_the_first_call():
    # `last_warned_at=None` means "never warned yet" — always fires.
    assert sla.should_warn_persist_failure(None, now=1_000_000.0) is True


def test_should_warn_persist_failure_suppressed_inside_the_cooldown():
    last_warned_at = 1_000_000.0
    just_inside = last_warned_at + sla.LEASE_PERSIST_WARN_COOLDOWN_SECONDS - 1
    assert sla.should_warn_persist_failure(last_warned_at, now=just_inside) is False


def test_should_warn_persist_failure_fires_again_once_the_cooldown_elapses():
    last_warned_at = 1_000_000.0
    at_boundary = last_warned_at + sla.LEASE_PERSIST_WARN_COOLDOWN_SECONDS
    past_boundary = at_boundary + 1
    assert sla.should_warn_persist_failure(last_warned_at, now=at_boundary) is True
    assert sla.should_warn_persist_failure(last_warned_at, now=past_boundary) is True


# ---------------------------------------------------------------------------
# build_takeover_notification
# ---------------------------------------------------------------------------


def test_takeover_notification_wire_names_the_terminal():
    n = sla.build_takeover_notification(ui_mode="wire")
    assert "terminal" in n.body
    assert n.category == "system"
    assert n.severity == "warning"
    assert n.source_kind == "session_lease"
    assert n.source_id == "wire"


def test_takeover_notification_shell_names_the_browser_panel():
    n = sla.build_takeover_notification(ui_mode="shell")
    assert "browser panel" in n.body
    assert n.source_id == "shell"


def test_takeover_notification_ids_are_unique():
    a = sla.build_takeover_notification(ui_mode="wire")
    b = sla.build_takeover_notification(ui_mode="wire")
    assert a.id != b.id


# ---------------------------------------------------------------------------
# build_shell_refusal_message
# ---------------------------------------------------------------------------


def _owner(*, ui_mode: str, busy: bool) -> OwnerInfo:
    return OwnerInfo(
        holder=f"{ui_mode}:123",
        pid=123,
        ui_mode=ui_mode,  # type: ignore[arg-type]
        generation=1,
        heartbeat_at=0.0,
        busy=busy,
    )


def test_shell_refusal_message_names_the_browser_panel_when_wire_owns_it():
    msg = sla.build_shell_refusal_message(_owner(ui_mode="wire", busy=False))
    assert "browser panel" in msg
    assert "idle" in msg
    assert "takeover" in msg.lower()


def test_shell_refusal_message_names_another_terminal_when_shell_owns_it():
    msg = sla.build_shell_refusal_message(_owner(ui_mode="shell", busy=True))
    assert "another terminal session" in msg
    assert "busy" in msg


# ---------------------------------------------------------------------------
# parse_initialize_request_id
# ---------------------------------------------------------------------------


def test_parse_initialize_request_id_happy_path():
    line = json.dumps({"jsonrpc": "2.0", "id": "req-1", "method": "initialize"}).encode() + b"\n"
    assert sla.parse_initialize_request_id(line) == "req-1"


def test_parse_initialize_request_id_empty_line_is_eof():
    assert sla.parse_initialize_request_id(b"") is None


def test_parse_initialize_request_id_invalid_json():
    assert sla.parse_initialize_request_id(b"not json at all\n") is None


def test_parse_initialize_request_id_non_object_json():
    assert sla.parse_initialize_request_id(b"[1, 2, 3]\n") is None


def test_parse_initialize_request_id_missing_id():
    line = json.dumps({"jsonrpc": "2.0", "method": "initialize"}).encode()
    assert sla.parse_initialize_request_id(line) is None


def test_parse_initialize_request_id_non_string_id():
    line = json.dumps({"jsonrpc": "2.0", "id": 42, "method": "initialize"}).encode()
    assert sla.parse_initialize_request_id(line) is None


# ---------------------------------------------------------------------------
# build_session_owned_error — the exact shape Task 3's agentd must parse
# ---------------------------------------------------------------------------


def test_session_owned_error_shape_with_request_id():
    owner = _owner(ui_mode="shell", busy=True)
    resp = sla.build_session_owned_error(owner, "req-42")

    assert isinstance(resp, JSONRPCErrorResponse)
    assert resp.id == "req-42"
    assert resp.error.code == ErrorCodes.SESSION_OWNED
    assert resp.error.data == {"code": "session_owned", "ui_mode": "shell", "busy": True}


def test_session_owned_error_shape_without_request_id():
    owner = _owner(ui_mode="wire", busy=False)
    resp = sla.build_session_owned_error(owner, None)

    assert isinstance(resp, JSONRPCErrorResponseNullableID)
    assert resp.id is None
    assert resp.error.code == ErrorCodes.SESSION_OWNED
    assert resp.error.data == {"code": "session_owned", "ui_mode": "wire", "busy": False}


def test_session_owned_error_round_trips_through_json():
    # Byte-for-byte what goes on the wire, matching WireServer._write_loop's
    # own encoding (`model_dump_json().encode("utf-8") + b"\n"`).
    owner = _owner(ui_mode="wire", busy=True)
    resp = sla.build_session_owned_error(owner, "req-1")
    raw = resp.model_dump_json().encode("utf-8") + b"\n"
    decoded = json.loads(raw)

    assert decoded["id"] == "req-1"
    assert decoded["error"]["code"] == ErrorCodes.SESSION_OWNED
    assert decoded["error"]["data"] == {"code": "session_owned", "ui_mode": "wire", "busy": True}
