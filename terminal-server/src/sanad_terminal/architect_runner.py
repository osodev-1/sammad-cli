"""The Architect runner — `sanad --wire --agent architect` on the WireRunner
base with the read-only posture: questions and plan mode OFF, every inbound
request rejected. Governance holds by construction: the agent it runs cannot
mutate the blueprint; applying a drafted change is a separate, user-driven
POST to the transaction endpoint (M2).
"""

from __future__ import annotations

from pathlib import Path

from sanad_terminal.wire_runner import (
    TurnState,
    WireRunner,
    WireRunnerError,
    register_registry,
)

# routes_architect.py catches these names — keep them exported here.
ArchitectError = WireRunnerError

__all__ = [
    "ArchitectError",
    "ArchitectRunner",
    "TurnState",
    "drop_runner",
    "get_runner",
    "put_runner",
    "shutdown_runners",
]


class ArchitectRunner(WireRunner):
    def __init__(self, *, argv, cwd, env, uid=None, gid=None) -> None:  # noqa: ANN001
        super().__init__(
            argv=argv,
            cwd=cwd,
            env=env,
            uid=uid,
            gid=gid,
            client_name="sanad-architect-bridge",
            capabilities={"supports_question": False, "supports_plan_mode": False},
        )


# One runner per workspace root — mirrors the per-workspace lock in
# routes_blueprint. On a one-project-per-machine host there is exactly one.
_runners: dict[str, ArchitectRunner] = {}
register_registry(_runners)


def get_runner(root: Path) -> ArchitectRunner | None:
    return _runners.get(str(root))


def put_runner(root: Path, runner: ArchitectRunner) -> None:
    _runners[str(root)] = runner


async def drop_runner(root: Path) -> None:
    runner = _runners.pop(str(root), None)
    if runner is not None:
        await runner.stop()


async def shutdown_runners() -> None:
    runners = list(_runners.values())
    _runners.clear()
    for runner in runners:
        await runner.stop()
