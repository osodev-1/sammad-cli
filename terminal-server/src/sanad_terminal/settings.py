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
    # "railway" = the shared multi-user container (legacy); "task" = one
    # per-user compute task (AWS Fargate): single fixed user, flattened /data,
    # bearer-token internal auth, self-exit on idle.
    mode: str = "railway"
    port: int = 8080
    control_plane_url: str = "https://www.sanadcode.com"
    shared_secret: str = ""
    users_dir: Path = Path("/data/users")
    # -- task mode ------------------------------------------------------------
    fixed_user: str = ""  # SANAD_WORKSPACE_USER — the ONE Clerk uid this task serves
    agentd_token: str = ""  # AGENTD_TOKEN — derived bearer for /internal/* + redeem
    machine_nonce: str = ""  # MACHINE_NONCE — the run nonce the token derives from
    data_dir: Path = Path("/data")  # flattened {workspace,home,kimi-share} root
    agent_user: str = ""  # AGENT_USER — spawn the agent PTY as this OS user (uid split)
    idle_stop_seconds: float = 300.0  # zero sessions + no internal traffic → exit 0
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
    # argv for the drawer's plain shell (task mode).
    shell_argv: tuple[str, ...] = ("/bin/bash", "-l")
    # -- coder panel (P0) -----------------------------------------------------
    # Default-off master switch for /internal/coder/*; "1" is the only truthy.
    coder_enabled: bool = False
    # Panel-turn budgets — deliberately far below the CLI's raw 1000-step /
    # 24h-token ceilings; a runaway browser-driven turn burns quota unattended.
    coder_max_turn_seconds: float = 3600.0
    coder_max_steps_per_turn: int = 200
    # Live runner cap per workspace; write-lease arrives in P6.
    coder_max_conversations: int = 3
    # Durable coder journal (P3) retention caps — newest N turn files kept
    # per conversation, and a per-turn journal file size cap (breach stops
    # appending that turn and journals one `journal_overflow` error item).
    coder_journal_turns_keep: int = 20
    coder_journal_max_bytes: int = 20 * 1024 * 1024
    # Per-conversation server-side follow-up queue (P4b) depth cap — RAM-only
    # and otherwise unbounded, so an authenticated `POST /send {queue:true}`
    # spam loop must be capped like every other coder_* resource above.
    coder_max_queue_depth: int = 50
    # HMAC key for the blueprint trust store — agentd-env only, NEVER in the
    # child env. Empty = legacy unsigned store (local/dev/railway).
    trust_store_key: str = ""
    # -- architect panel (P1) -------------------------------------------------
    # Wall-clock bound on one architect turn — with idle probes holding the
    # machine during turns, a hung turn must cancel rather than hold the
    # machine forever.
    architect_max_turn_seconds: float = 1800.0
    # -- worker runs (P0) -------------------------------------------------------
    # Default-off master switch for ephemeral worker runs; "1" is the only truthy.
    worker_enabled: bool = False
    # Per-run budgets — a worker run is afk (no attached browser can cancel it
    # early), so these are the only backstop against a runaway subprocess.
    worker_max_turn_seconds: float = 900.0
    worker_max_steps_per_turn: int = 100
    worker_max_tokens_per_run: int = 2_000_000
    # Keep the underlying compute warm between runs instead of scaling to zero.
    keep_warm: bool = False
    # -- agent process ulimits (P2a) -------------------------------------------
    # Resource caps applied to the spawned agent's OS user (uid-split mode
    # only — preexec gates on uid being set). A fork-bomb or disk-fill inside
    # the agent's own process tree stays bounded. `0` disables that limit.
    agent_rlimit_nproc: int = 512
    agent_rlimit_fsize: int = 4 * 1024**3

    @classmethod
    def load(cls, env: Mapping[str, str] | None = None) -> TerminalSettings:
        e = os.environ if env is None else env

        mode = e.get("WORKSPACE_MODE", "railway")
        if mode not in ("railway", "task"):
            raise SettingsError(f"WORKSPACE_MODE must be railway|task, got {mode!r}")

        secret = e.get("TERMINAL_SHARED_SECRET", "")
        fixed_user = e.get("SANAD_WORKSPACE_USER", "")
        agentd_token = e.get("AGENTD_TOKEN", "")
        if mode == "railway" and not secret:
            raise SettingsError("TERMINAL_SHARED_SECRET is required in railway mode")
        if mode == "task":
            if not fixed_user:
                raise SettingsError("SANAD_WORKSPACE_USER is required in task mode")
            if not agentd_token:
                raise SettingsError("AGENTD_TOKEN is required in task mode")
            # Fail-closed on the trust-hardening prerequisites: without the HMAC
            # key the store loads unverified (legacy path), and without the uid
            # split the key is /proc-readable by the agent and the rlimits no-op.
            # A governed machine that can't guarantee both must not boot.
            if not e.get("TRUST_STORE_KEY", ""):
                raise SettingsError("TRUST_STORE_KEY is required in task mode")
            if not e.get("AGENT_USER", ""):
                raise SettingsError("AGENT_USER is required in task mode")

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
            mode=mode,
            port=int(e.get("PORT", "7070" if mode == "task" else "8080")),
            control_plane_url=control_plane,
            shared_secret=secret,
            users_dir=Path(e.get("USERS_DIR", "/data/users")),
            fixed_user=fixed_user,
            agentd_token=agentd_token,
            machine_nonce=e.get("MACHINE_NONCE", ""),
            data_dir=Path(e.get("DATA_DIR", "/data")),
            agent_user=e.get("AGENT_USER", ""),
            idle_stop_seconds=float(e.get("IDLE_STOP_SECONDS", "300")),
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
            shell_argv=tuple((e.get("SHELL_ARGV") or "/bin/bash -l").split()),
            coder_enabled=e.get("CODER_ENABLED", "") == "1",
            coder_max_turn_seconds=float(e.get("CODER_MAX_TURN_SECONDS", "3600")),
            coder_max_steps_per_turn=int(e.get("CODER_MAX_STEPS_PER_TURN", "200")),
            coder_max_conversations=int(e.get("CODER_MAX_CONVERSATIONS", "3")),
            coder_journal_turns_keep=int(e.get("CODER_JOURNAL_TURNS_KEEP", "20")),
            coder_journal_max_bytes=int(e.get("CODER_JOURNAL_MAX_BYTES", str(20 * 1024 * 1024))),
            coder_max_queue_depth=int(e.get("CODER_MAX_QUEUE_DEPTH", "50")),
            trust_store_key=e.get("TRUST_STORE_KEY", ""),
            architect_max_turn_seconds=float(e.get("ARCHITECT_MAX_TURN_SECONDS", "1800")),
            worker_enabled=e.get("WORKER_ENABLED", "") == "1",
            worker_max_turn_seconds=float(e.get("WORKER_MAX_TURN_SECONDS", "900")),
            worker_max_steps_per_turn=int(e.get("WORKER_MAX_STEPS_PER_TURN", "100")),
            worker_max_tokens_per_run=int(e.get("WORKER_MAX_TOKENS_PER_RUN", "2000000")),
            keep_warm=e.get("KEEP_WARM", "") == "1",
            agent_rlimit_nproc=int(e.get("AGENT_RLIMIT_NPROC", "512")),
            agent_rlimit_fsize=int(e.get("AGENT_RLIMIT_FSIZE", str(4 * 1024**3))),
        )
