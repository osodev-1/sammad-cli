from pathlib import Path

import pytest
from sanad_terminal.settings import SettingsError, TerminalSettings

BASE_ENV = {
    "TERMINAL_SHARED_SECRET": "s3cret",
    "TERMINAL_SPAWN_ARGV": "/bin/echo run",
}


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
