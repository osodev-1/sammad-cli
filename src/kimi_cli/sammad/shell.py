"""Governance shims for the interactive shell.

A governed sammad session authenticates only through ``sammad login`` (the
brokered Entra device flow) and routes every model call through the gateway.
Upstream's in-shell provider-OAuth commands — ``/login``, ``/logout``, and the
``setup`` alias — target Moonshot's auth (``auth.kimi.com``) and would let a user
attach a personal provider key, which the governance model forbids. They are
removed from the governed shell here so the upstream edit stays a one-line call.
"""

from __future__ import annotations

from typing import Protocol

# Upstream command *names* removed from the governed shell. The ``setup`` alias
# rides on the ``login`` command, so suppressing the command drops the alias too.
SUPPRESSED_SLASH_COMMANDS = frozenset({"login", "logout"})


class _NamedCommand(Protocol):
    name: str


def suppress_governed_commands[C: _NamedCommand](commands: list[C]) -> list[C]:
    """Drop the governance-suppressed slash commands from ``commands``.

    Filters by ``.name``; a command whose name is in
    :data:`SUPPRESSED_SLASH_COMMANDS` is removed (its aliases go with it, since
    the shell only indexes aliases of the commands that survive).
    """
    return [c for c in commands if c.name not in SUPPRESSED_SLASH_COMMANDS]
