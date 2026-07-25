"""The governed shell drops upstream's Moonshot-OAuth slash commands.

A governed sammad session authenticates only through `sammad login` and routes
models through the gateway, so upstream's in-shell `/login`, `/logout`, and the
`setup` alias (provider OAuth against auth.kimi.com) must not be reachable.
"""

from __future__ import annotations

from kimi_cli.sammad.shell import SUPPRESSED_SLASH_COMMANDS, suppress_governed_commands


class _Cmd:
    def __init__(self, name: str) -> None:
        self.name = name


def test_suppress_removes_login_and_logout_keeps_others() -> None:
    cmds = [_Cmd("login"), _Cmd("logout"), _Cmd("model"), _Cmd("help")]
    assert [c.name for c in suppress_governed_commands(cmds)] == ["model", "help"]


def test_suppressed_set_targets_the_moonshot_oauth_commands() -> None:
    assert sorted(SUPPRESSED_SLASH_COMMANDS) == ["login", "logout"]


def test_governed_shell_exposes_no_login_logout_or_setup() -> None:
    # Faithful check against the real Shell assembly: build a Shell with a stub
    # soul (no soul-level commands) and confirm the shell-registry commands
    # /login, /logout, and the `setup` alias (which rides on /login) are all
    # unreachable, while a real command (/model) still resolves.
    from kimi_cli.ui.shell import Shell

    class _StubSoul:
        available_slash_commands = ()

    shell = Shell(_StubSoul())  # type: ignore[arg-type]
    for name in ("login", "logout", "setup"):
        assert shell._find_available_slash_command(name) is None, name
    assert shell._find_available_slash_command("model") is not None
