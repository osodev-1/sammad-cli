from pathlib import Path

import pytest
from sanad_terminal.settings import SettingsError, TerminalSettings

BASE_ENV = {
    "TERMINAL_SHARED_SECRET": "s3cret",
    "TERMINAL_SPAWN_ARGV": "/bin/echo run",
}


@pytest.fixture
def base_env():
    return BASE_ENV.copy()


def test_load_defaults():
    s = TerminalSettings.load(BASE_ENV)
    assert s.port == 8080
    assert s.control_plane_url == "https://www.sanadcode.com"
    assert s.child_api_base_url == "https://www.sanadcode.com"
    assert s.users_dir == Path("/data/users")
    assert s.allowed_origins == ("https://www.sanadcode.com",)
    assert s.spawn_argv == ("/bin/echo", "run")


def test_missing_secret_fails_fast():
    with pytest.raises(SettingsError, match="TERMINAL_SHARED_SECRET"):
        TerminalSettings.load({"TERMINAL_SPAWN_ARGV": "/bin/echo"})


def test_missing_sanad_binary_fails_fast(monkeypatch):
    monkeypatch.setattr("shutil.which", lambda name: None)
    with pytest.raises(SettingsError, match="sanad"):
        TerminalSettings.load({"TERMINAL_SHARED_SECRET": "x"})


def test_env_overrides():
    s = TerminalSettings.load(
        {
            **BASE_ENV,
            "PORT": "9999",
            "CONTROL_PLANE_URL": "https://cp.test/",
            "SANAD_API_BASE_URL": "https://api.test/",
            "USERS_DIR": "/tmp/users",
            "TERMINAL_ALLOWED_ORIGINS": "https://a.test, https://b.test,",
            "IDLE_TIMEOUT_SECONDS": "60",
            "MAX_SESSION_SECONDS": "120",
        }
    )
    assert s.port == 9999
    assert s.control_plane_url == "https://cp.test"
    assert s.child_api_base_url == "https://api.test"
    assert s.users_dir == Path("/tmp/users")
    assert s.allowed_origins == ("https://a.test", "https://b.test")
    assert s.idle_timeout_seconds == 60.0
    assert s.max_session_seconds == 120.0


def test_coder_flags_default_off_and_budgets_default(base_env):
    s = TerminalSettings.load(env=base_env)
    assert s.coder_enabled is False
    assert s.coder_max_turn_seconds == 3600.0
    assert s.coder_max_steps_per_turn == 200


def test_coder_flags_parse_from_env(base_env):
    s = TerminalSettings.load(
        env={
            **base_env,
            "CODER_ENABLED": "1",
            "CODER_MAX_TURN_SECONDS": "120",
            "CODER_MAX_STEPS_PER_TURN": "7",
        }
    )
    assert s.coder_enabled is True
    assert s.coder_max_turn_seconds == 120.0
    assert s.coder_max_steps_per_turn == 7


def test_coder_enabled_requires_exactly_one(base_env):
    assert TerminalSettings.load(env={**base_env, "CODER_ENABLED": "true"}).coder_enabled is False
    assert TerminalSettings.load(env={**base_env, "CODER_ENABLED": "0"}).coder_enabled is False


def test_coder_conversation_cap_defaults_and_parses(base_env):
    assert TerminalSettings.load(env=base_env).coder_max_conversations == 3
    s = TerminalSettings.load(env={**base_env, "CODER_MAX_CONVERSATIONS": "5"})
    assert s.coder_max_conversations == 5


def test_architect_budget_defaults_and_parses(base_env):
    assert TerminalSettings.load(env=base_env).architect_max_turn_seconds == 1800.0
    s = TerminalSettings.load(env={**base_env, "ARCHITECT_MAX_TURN_SECONDS": "60"})
    assert s.architect_max_turn_seconds == 60.0


def test_trust_store_key_parses(base_env):
    assert TerminalSettings.load(env=base_env).trust_store_key == ""
    s = TerminalSettings.load(env={**base_env, "TRUST_STORE_KEY": "abc"})
    assert s.trust_store_key == "abc"


def test_agent_rlimit_defaults_and_parses(base_env):
    s = TerminalSettings.load(env=base_env)
    assert s.agent_rlimit_nproc == 512
    assert s.agent_rlimit_fsize == 4 * 1024**3
    s2 = TerminalSettings.load(
        env={**base_env, "AGENT_RLIMIT_NPROC": "128", "AGENT_RLIMIT_FSIZE": "1073741824"}
    )
    assert s2.agent_rlimit_nproc == 128
    assert s2.agent_rlimit_fsize == 1073741824


def test_agent_rlimit_zero_disables(base_env):
    s = TerminalSettings.load(
        env={**base_env, "AGENT_RLIMIT_NPROC": "0", "AGENT_RLIMIT_FSIZE": "0"}
    )
    assert s.agent_rlimit_nproc == 0
    assert s.agent_rlimit_fsize == 0


def test_coder_journal_caps_default(base_env):
    s = TerminalSettings.load(env=base_env)
    assert s.coder_journal_turns_keep == 20
    assert s.coder_journal_max_bytes == 20 * 1024 * 1024


def test_coder_journal_caps_parse_from_env(base_env):
    s = TerminalSettings.load(
        env={
            **base_env,
            "CODER_JOURNAL_TURNS_KEEP": "5",
            "CODER_JOURNAL_MAX_BYTES": "1048576",
        }
    )
    assert s.coder_journal_turns_keep == 5
    assert s.coder_journal_max_bytes == 1048576


def test_coder_max_queue_depth_default_and_parses(base_env):
    assert TerminalSettings.load(env=base_env).coder_max_queue_depth == 50
    s = TerminalSettings.load(env={**base_env, "CODER_MAX_QUEUE_DEPTH": "5"})
    assert s.coder_max_queue_depth == 5


def test_coder_diff_max_bytes_default_and_parses(base_env):
    assert TerminalSettings.load(env=base_env).coder_diff_max_bytes == 200_000
    s = TerminalSettings.load(env={**base_env, "CODER_DIFF_MAX_BYTES": "1000"})
    assert s.coder_diff_max_bytes == 1000


def test_coder_write_lease_ttl_default_and_parses(base_env):
    s = TerminalSettings.load(env=base_env)
    assert s.coder_write_lease_ttl_seconds == 3900
    # The lease is held for a whole turn — the TTL must never be able to
    # reclaim from a turn that is merely long.
    assert s.coder_write_lease_ttl_seconds > s.coder_max_turn_seconds
    # A configured value ABOVE the floor is honoured verbatim.
    s = TerminalSettings.load(env={**base_env, "CODER_WRITE_LEASE_TTL_SECONDS": "9000"})
    assert s.coder_write_lease_ttl_seconds == 9000


def test_write_lease_ttl_is_clamped_above_the_turn_budget(base_env):
    """The TTL invariant is DERIVED, not just documented. `try_acquire`'s
    stale branch grants unconditionally once the TTL elapses, assuming a
    lease that old means a leaked release — false for any turn longer than
    the TTL, which would turn leak-recovery into a mis-grant (a second
    writer on a worktree an agent is still writing to)."""
    # Configured below the floor → clamped to turn-budget + 300.
    s = TerminalSettings.load(env={**base_env, "CODER_WRITE_LEASE_TTL_SECONDS": "60"})
    assert s.coder_write_lease_ttl_seconds == int(s.coder_max_turn_seconds) + 300
    assert s.coder_write_lease_ttl_seconds > s.coder_max_turn_seconds

    # Raising ONLY the turn budget must not silently invert the invariant.
    s = TerminalSettings.load(env={**base_env, "CODER_MAX_TURN_SECONDS": "7200"})
    assert s.coder_write_lease_ttl_seconds == 7500
    assert s.coder_write_lease_ttl_seconds > s.coder_max_turn_seconds


def test_session_locks_default_off_and_parses_from_env(base_env):
    """`SANAD_SESSION_LOCKS` (P6b) — default off, "1" the only truthy, SAME
    var name `kimi_cli.sanad.session_lock.locks_enabled()` reads so agentd
    and the CLI it spawns agree on whether the lease is active."""
    assert TerminalSettings.load(env=base_env).session_locks_enabled is False
    assert (
        TerminalSettings.load(env={**base_env, "SANAD_SESSION_LOCKS": "1"}).session_locks_enabled
        is True
    )
    assert (
        TerminalSettings.load(env={**base_env, "SANAD_SESSION_LOCKS": "true"}).session_locks_enabled
        is False
    )


def test_coder_takeover_wait_and_poll_defaults_and_parse(base_env):
    s = TerminalSettings.load(env=base_env)
    assert s.coder_takeover_wait_seconds == 15.0
    assert s.coder_takeover_poll_seconds == 0.5
    s = TerminalSettings.load(
        env={
            **base_env,
            "CODER_TAKEOVER_WAIT_SECONDS": "20",
            "CODER_TAKEOVER_POLL_SECONDS": "1",
        }
    )
    assert s.coder_takeover_wait_seconds == 20.0
    assert s.coder_takeover_poll_seconds == 1.0


def test_write_lease_ttl_default_matches_the_lease_module_fallback(base_env):
    """The settings default and `workspace_lease`'s fallback constant are two
    independent literals; if they drift, a lease created before any settings
    caller reaches it would silently use a different TTL than configured."""
    from sanad_terminal.workspace_lease import DEFAULT_STALE_AFTER_SECONDS

    s = TerminalSettings.load(env=base_env)
    assert float(s.coder_write_lease_ttl_seconds) == DEFAULT_STALE_AFTER_SECONDS
