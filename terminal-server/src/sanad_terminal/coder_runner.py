"""The Coder runner — `sanad --wire --session <conversationId>` on the
WireRunner base. One runner per CONVERSATION (not per workspace): a
conversation IS a kimi session id, which is what makes "one brain, two
views" literal later (the TUI resumes the same id).

P0 posture: capabilities are false/false and the base rejects every inbound
request, so any gated tool call resolves as DENIED — the most-restrictive
stance. P1's approvals bridge flips the capabilities and overrides
`on_request`. Budgets are mandatory here (settings-driven), unlike the
architect: a browser-driven turn can run unattended and must be bounded.
"""

from __future__ import annotations

import re
import uuid
from pathlib import Path

from sanad_terminal.wire_runner import WireRunner, register_registry

# Server-minted only (P0); the shape keeps ids path- and shell-safe.
CONVERSATION_ID_RE = re.compile(r"^c_[a-f0-9]{12}$")


def new_conversation_id() -> str:
    return f"c_{uuid.uuid4().hex[:12]}"


class CoderRunner(WireRunner):
    def __init__(
        self,
        *,
        conversation_id: str,
        argv,  # noqa: ANN001
        cwd: Path,
        env: dict[str, str],
        uid: int | None = None,
        gid: int | None = None,
        max_turn_seconds: float,
        max_steps_per_turn: int,
    ) -> None:
        super().__init__(
            argv=argv,
            cwd=cwd,
            env=env,
            uid=uid,
            gid=gid,
            client_name="sanad-coder-bridge",
            capabilities={"supports_question": False, "supports_plan_mode": False},
            max_turn_seconds=max_turn_seconds,
            max_steps_per_turn=max_steps_per_turn,
        )
        self.conversation_id = conversation_id


def _key(root: Path, conversation_id: str) -> str:
    return f"{root}::{conversation_id}"


# Keyed by (workspace root, conversation) — one machine serves one workspace
# in task mode, but railway mode shares a host, and the blueprint locks key by
# root for the same reason. Registered with wire_runner so an active coder
# turn holds the machine open (IdleStopper probe).
_conversations: dict[str, CoderRunner] = {}
register_registry(_conversations)


def get_conversation(root: Path, conversation_id: str) -> CoderRunner | None:
    return _conversations.get(_key(root, conversation_id))


def put_conversation(root: Path, runner: CoderRunner) -> None:
    _conversations[_key(root, runner.conversation_id)] = runner


async def drop_conversation(root: Path, conversation_id: str) -> None:
    runner = _conversations.pop(_key(root, conversation_id), None)
    if runner is not None:
        await runner.stop()


def list_conversations(root: Path) -> list[CoderRunner]:
    prefix = f"{root}::"
    return [r for k, r in _conversations.items() if k.startswith(prefix)]


async def shutdown_conversations() -> None:
    runners = list(_conversations.values())
    _conversations.clear()
    for runner in runners:
        await runner.stop()
