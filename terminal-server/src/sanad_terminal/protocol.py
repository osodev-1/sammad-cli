"""The WS control-frame vocabulary (text frames; binary frames are PTY bytes).

Client → server: auth (must be first, carries the one-time ticket so it never
appears in a URL), resize, ping. Server → client: ready, pong, warning, exit,
error. Kept in lockstep with sanad-web's lib/terminal/protocol.ts.
"""

from __future__ import annotations

import json
from typing import Annotated, Literal

from pydantic import BaseModel, Field, ValidationError

MIN_COLS, MAX_COLS = 20, 500
MIN_ROWS, MAX_ROWS = 5, 300


class ProtocolError(Exception):
    """A text frame that is not a valid client control message."""


class AuthFrame(BaseModel):
    type: Literal["auth"]
    ticket: str = Field(min_length=1, max_length=256)
    cols: int = Field(default=80, ge=1, le=10_000)
    rows: int = Field(default=24, ge=1, le=10_000)


class ResizeFrame(BaseModel):
    type: Literal["resize"]
    cols: int = Field(ge=1, le=10_000)
    rows: int = Field(ge=1, le=10_000)


class PingFrame(BaseModel):
    type: Literal["ping"]


ClientFrame = Annotated[AuthFrame | ResizeFrame | PingFrame, Field(discriminator="type")]


class _ClientFrameWrapper(BaseModel):
    frame: ClientFrame


def parse_client_frame(text: str) -> AuthFrame | ResizeFrame | PingFrame:
    try:
        raw = json.loads(text)
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise ProtocolError(f"not JSON: {exc}") from exc
    try:
        return _ClientFrameWrapper(frame=raw).frame
    except ValidationError as exc:
        raise ProtocolError(f"invalid control frame: {exc}") from exc


def clamp_size(cols: int, rows: int) -> tuple[int, int]:
    """Clamp a client-requested grid to sane PTY bounds."""
    return (
        min(max(cols, MIN_COLS), MAX_COLS),
        min(max(rows, MIN_ROWS), MAX_ROWS),
    )


# -- server → client builders -------------------------------------------------


def ready_frame(user_id: str, cols: int, rows: int) -> str:
    return json.dumps({"type": "ready", "userId": user_id, "cols": cols, "rows": rows})


def pong_frame() -> str:
    return json.dumps({"type": "pong"})


def warning_frame(reason: str, seconds_left: float) -> str:
    return json.dumps({"type": "warning", "reason": reason, "secondsLeft": int(seconds_left)})


def exit_frame(code: int | None) -> str:
    return json.dumps({"type": "exit", "code": code})


def error_frame(code: str, message: str = "") -> str:
    payload: dict[str, str] = {"type": "error", "code": code}
    if message:
        payload["message"] = message
    return json.dumps(payload)


# WS close codes (kept in lockstep with the frontend)
CLOSE_NORMAL = 1000
CLOSE_INTERNAL = 1011
CLOSE_IDLE = 4000
CLOSE_LIFETIME = 4001
CLOSE_PROTOCOL = 4400
CLOSE_AUTH = 4401
CLOSE_AUTH_TIMEOUT = 4408
CLOSE_REPLACED = 4409
CLOSE_EXPIRED = 4410
