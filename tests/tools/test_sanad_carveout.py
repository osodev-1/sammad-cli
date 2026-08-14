"""Tests for the `.sanad` edit carve-out: writes inside <work_dir>/.sanad always re-prompt."""

from __future__ import annotations

import asyncio

import pytest
from kaos.path import KaosPath

from kimi_cli.approval_runtime.models import ApprovalRequestRecord
from kimi_cli.soul.approval import Approval
from kimi_cli.tools.file.write import Params, WriteFile


@pytest.fixture
def approval() -> Approval:
    """Override the default yolo fixture — these tests exercise manual approval prompts."""
    return Approval()


async def _await_pending(approval: Approval, timeout: float = 2.0) -> list[ApprovalRequestRecord]:
    """Poll until at least one approval request is pending.

    WriteFile performs several real awaits (fs stat/read, diff building) before
    reaching ``approval.request``, so a single ``asyncio.sleep(0)`` is not enough
    to let it get there.
    """

    async def _poll() -> list[ApprovalRequestRecord]:
        while True:
            pending = approval._runtime.list_pending()
            if pending:
                return pending
            await asyncio.sleep(0)

    return await asyncio.wait_for(_poll(), timeout=timeout)


async def test_sanad_write_requests_edit_sanad_definition(
    write_file_tool: WriteFile, temp_work_dir: KaosPath, approval: Approval
):
    """Writing inside <work_dir>/.sanad requests the 'edit sanad definition' action."""
    file_path = temp_work_dir / ".sanad" / "skills" / "x" / "SKILL.md"
    await file_path.parent.mkdir(parents=True, exist_ok=True)

    task = asyncio.create_task(write_file_tool(Params(path=str(file_path), content="hi")))
    pending = await _await_pending(approval)
    assert len(pending) == 1
    assert pending[0].action == "edit sanad definition"
    approval._runtime.resolve(pending[0].id, "approve")

    result = await task
    assert not result.is_error


async def test_sanad_approve_for_session_does_not_suppress_second_prompt(
    write_file_tool: WriteFile, temp_work_dir: KaosPath, approval: Approval
):
    """approve_for_session on a .sanad write must not cache the action for later writes."""
    sanad_dir = temp_work_dir / ".sanad" / "skills" / "x"
    await sanad_dir.mkdir(parents=True, exist_ok=True)
    file_a = sanad_dir / "SKILL.md"
    file_b = sanad_dir / "SKILL2.md"

    task1 = asyncio.create_task(write_file_tool(Params(path=str(file_a), content="hi")))
    pending1 = await _await_pending(approval)
    assert len(pending1) == 1
    approval._runtime.resolve(pending1[0].id, "approve_for_session")
    result1 = await task1
    assert not result1.is_error
    assert "edit sanad definition" not in approval._state.auto_approve_actions

    task2 = asyncio.create_task(write_file_tool(Params(path=str(file_b), content="hi")))
    pending2 = await _await_pending(approval)
    assert len(pending2) == 1
    assert pending2[0].action == "edit sanad definition"
    approval._runtime.resolve(pending2[0].id, "approve")

    result2 = await task2
    assert not result2.is_error


async def test_normal_write_still_uses_edit_file_action(
    write_file_tool: WriteFile, temp_work_dir: KaosPath, approval: Approval
):
    """A write to a normal workspace path (outside .sanad) still uses 'edit file'."""
    file_path = temp_work_dir / "normal.txt"

    task = asyncio.create_task(write_file_tool(Params(path=str(file_path), content="hi")))
    pending = await _await_pending(approval)
    assert len(pending) == 1
    assert pending[0].action == "edit file"
    approval._runtime.resolve(pending[0].id, "approve")

    result = await task
    assert not result.is_error
