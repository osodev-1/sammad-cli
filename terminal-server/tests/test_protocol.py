import json

import pytest
from sanad_terminal.protocol import (
    AuthFrame,
    PingFrame,
    ProtocolError,
    ResizeFrame,
    clamp_size,
    error_frame,
    exit_frame,
    parse_client_frame,
    ready_frame,
    warning_frame,
)


def test_parse_auth_with_defaults():
    frame = parse_client_frame('{"type":"auth","ticket":"tt_x"}')
    assert isinstance(frame, AuthFrame)
    assert frame.ticket == "tt_x"
    assert (frame.cols, frame.rows) == (80, 24)


def test_parse_resize_and_ping():
    resize = parse_client_frame('{"type":"resize","cols":120,"rows":40}')
    assert isinstance(resize, ResizeFrame)
    assert (resize.cols, resize.rows) == (120, 40)
    assert isinstance(parse_client_frame('{"type":"ping"}'), PingFrame)


@pytest.mark.parametrize(
    "raw",
    [
        "not json",
        "[]",
        '{"type":"unknown"}',
        '{"type":"auth"}',  # missing ticket
        '{"type":"resize","cols":0,"rows":10}',  # out of model bounds
    ],
)
def test_malformed_frames_raise(raw: str):
    with pytest.raises(ProtocolError):
        parse_client_frame(raw)


def test_clamp_size_bounds():
    assert clamp_size(1, 1) == (20, 5)
    assert clamp_size(10_000, 10_000) == (500, 300)
    assert clamp_size(120, 40) == (120, 40)


def test_server_frame_shapes():
    assert json.loads(ready_frame("user_1", 120, 40)) == {
        "type": "ready",
        "userId": "user_1",
        "cols": 120,
        "rows": 40,
    }
    assert json.loads(exit_frame(0)) == {"type": "exit", "code": 0}
    assert json.loads(exit_frame(None)) == {"type": "exit", "code": None}
    assert json.loads(warning_frame("idle", 299.9)) == {
        "type": "warning",
        "reason": "idle",
        "secondsLeft": 299,
    }
    assert json.loads(error_frame("invalid_ticket")) == {
        "type": "error",
        "code": "invalid_ticket",
    }
    assert json.loads(error_frame("protocol_error", "bad")) == {
        "type": "error",
        "code": "protocol_error",
        "message": "bad",
    }
