from __future__ import annotations

from unittest.mock import Mock

from kimi_cli.ui.shell.migration_nudge import print_migration_goodbye


def test_goodbye_is_just_a_goodbye():
    """sanad fork: the upstream Kimi Code migration nudge is removed — the
    graceful-exit farewell prints "Bye!" and nothing else."""
    console = Mock()
    print_migration_goodbye(console)
    assert console.print.call_count == 1
    assert console.print.call_args.args[0] == "Bye!"
