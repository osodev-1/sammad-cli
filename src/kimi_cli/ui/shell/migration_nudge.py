"""Farewell message printed on graceful exit.

sanad fork: upstream used this module to nudge users toward Moonshot's
standalone "Kimi Code" (an `/upgrade` command, welcome cards, and a throttled
exit tip running a curl-install of code.kimi.com). Those flows would replace
the governed CLI with an ungoverned upstream build, so the fork removes them
entirely — the goodbye is just a goodbye.
"""

from __future__ import annotations

from rich.console import Console


def print_migration_goodbye(console: Console) -> None:
    """Print the farewell on graceful exit."""
    console.print("Bye!")
