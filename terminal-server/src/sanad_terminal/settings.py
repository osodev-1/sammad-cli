"""Environment-driven service configuration (fail-fast on misconfiguration)."""

from __future__ import annotations

import os
import shutil
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path


class SettingsError(Exception):
    """Raised when the environment is unusable; the service must not boot."""


@dataclass(frozen=True, slots=True)
class TerminalSettings:
    port: int = 8080
    control_plane_url: str = "https://www.sanadcode.com"
    shared_secret: str = ""
    users_dir: Path = Path("/data/users")
    allowed_origins: tuple[str, ...] = ("https://www.sanadcode.com",)
    idle_timeout_seconds: float = 1800.0
    idle_warning_seconds: float = 300.0
    max_session_seconds: float = 14400.0
    auth_frame_timeout_seconds: float = 10.0
    max_upload_bytes: int = 100 * 1024 * 1024
    # Concurrent terminals per user; opening one more evicts the oldest.
    max_sessions_per_user: int = 3
    # How long a QUIET detached agent (socket dropped, no output) runs before reap.
    detach_grace_seconds: float = 900.0
    # Watchdog/sweeper cadence; only tests shrink this.
    watchdog_tick_seconds: float = 15.0
    # SANAD_API_BASE_URL handed to the spawned agent; defaults to control_plane_url.
    child_api_base_url: str = ""
    # argv used to launch the agent; resolved from PATH unless overridden (tests).
    spawn_argv: tuple[str, ...] = field(default_factory=tuple)

    @classmethod
    def load(cls, env: Mapping[str, str] | None = None) -> TerminalSettings:
        e = os.environ if env is None else env

        secret = e.get("TERMINAL_SHARED_SECRET", "")
        if not secret:
            raise SettingsError("TERMINAL_SHARED_SECRET is required")

        spawn = e.get("TERMINAL_SPAWN_ARGV", "")
        if spawn:
            argv = tuple(spawn.split())
        else:
            sanad = shutil.which("sanad")
            if not sanad:
                raise SettingsError(
                    "`sanad` not found on PATH (set TERMINAL_SPAWN_ARGV to override)"
                )
            argv = (sanad, "run")

        origins = tuple(
            o.strip()
            for o in e.get("TERMINAL_ALLOWED_ORIGINS", "https://www.sanadcode.com").split(",")
            if o.strip()
        )

        control_plane = e.get("CONTROL_PLANE_URL", "https://www.sanadcode.com").rstrip("/")
        return cls(
            port=int(e.get("PORT", "8080")),
            control_plane_url=control_plane,
            shared_secret=secret,
            users_dir=Path(e.get("USERS_DIR", "/data/users")),
            allowed_origins=origins,
            idle_timeout_seconds=float(e.get("IDLE_TIMEOUT_SECONDS", "1800")),
            idle_warning_seconds=float(e.get("IDLE_WARNING_SECONDS", "300")),
            max_session_seconds=float(e.get("MAX_SESSION_SECONDS", "14400")),
            auth_frame_timeout_seconds=float(e.get("AUTH_FRAME_TIMEOUT_SECONDS", "10")),
            max_upload_bytes=int(e.get("MAX_UPLOAD_BYTES", str(100 * 1024 * 1024))),
            max_sessions_per_user=int(e.get("MAX_SESSIONS_PER_USER", "3")),
            detach_grace_seconds=float(e.get("DETACH_GRACE_SECONDS", "900")),
            child_api_base_url=e.get("SANAD_API_BASE_URL", control_plane).rstrip("/"),
            spawn_argv=argv,
        )
