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


# --- symlink hardening: classification must reflect the resolved destination ---


async def test_sanad_write_through_symlinked_directory_still_classifies_sanad(
    write_file_tool: WriteFile, temp_work_dir: KaosPath, approval: Approval
):
    """A workspace symlink DIRECTORY pointing at .sanad must not disguise the write."""
    local_work_dir = temp_work_dir.unsafe_to_local_path()
    sanad_skills_dir = local_work_dir / ".sanad" / "skills" / "x"
    sanad_skills_dir.mkdir(parents=True, exist_ok=True)
    mylink = local_work_dir / "mylink"
    mylink.symlink_to(local_work_dir / ".sanad", target_is_directory=True)

    file_path = temp_work_dir / "mylink" / "skills" / "x" / "SKILL.md"

    task = asyncio.create_task(write_file_tool(Params(path=str(file_path), content="hi")))
    pending = await _await_pending(approval)
    assert len(pending) == 1
    assert pending[0].action == "edit sanad definition"
    approval._runtime.resolve(pending[0].id, "approve")

    result = await task
    assert not result.is_error


async def test_sanad_write_through_symlinked_file_still_classifies_sanad(
    write_file_tool: WriteFile, temp_work_dir: KaosPath, approval: Approval
):
    """A workspace symlink FILE whose target is inside .sanad must not disguise the write."""
    local_work_dir = temp_work_dir.unsafe_to_local_path()
    sanad_skills_dir = local_work_dir / ".sanad" / "skills" / "x"
    sanad_skills_dir.mkdir(parents=True, exist_ok=True)
    real_file = sanad_skills_dir / "REAL.md"
    real_file.write_text("original")
    linked_file = local_work_dir / "linked.md"
    linked_file.symlink_to(real_file)

    file_path = temp_work_dir / "linked.md"

    task = asyncio.create_task(write_file_tool(Params(path=str(file_path), content="hi")))
    pending = await _await_pending(approval)
    assert len(pending) == 1
    assert pending[0].action == "edit sanad definition"
    approval._runtime.resolve(pending[0].id, "approve")

    result = await task
    assert not result.is_error


async def test_symlink_elsewhere_in_workspace_still_uses_edit_file(
    write_file_tool: WriteFile, temp_work_dir: KaosPath, approval: Approval
):
    """A symlink that does not point into .sanad must not be misclassified (no false positive)."""
    local_work_dir = temp_work_dir.unsafe_to_local_path()
    real_dir = local_work_dir / "real_elsewhere"
    real_dir.mkdir(parents=True, exist_ok=True)
    other_link = local_work_dir / "other_link"
    other_link.symlink_to(real_dir, target_is_directory=True)

    file_path = temp_work_dir / "other_link" / "file.txt"

    task = asyncio.create_task(write_file_tool(Params(path=str(file_path), content="hi")))
    pending = await _await_pending(approval)
    assert len(pending) == 1
    assert pending[0].action == "edit file"
    approval._runtime.resolve(pending[0].id, "approve")

    result = await task
    assert not result.is_error


async def test_symlink_retarget_after_approval_writes_to_classified_location(
    write_file_tool: WriteFile, temp_work_dir: KaosPath, approval: Approval
):
    """TOCTOU: retargeting the symlink between approval and write must not redirect
    the bytes. The write follows the location resolved (and approved) at
    classification time, not the symlink's later destination."""
    local_work_dir = temp_work_dir.unsafe_to_local_path()
    sanad_target_dir = local_work_dir / ".sanad" / "skills" / "x"
    sanad_target_dir.mkdir(parents=True, exist_ok=True)
    decoy_dir = local_work_dir / "decoy" / "skills" / "x"
    decoy_dir.mkdir(parents=True, exist_ok=True)

    mylink = local_work_dir / "mylink"
    mylink.symlink_to(local_work_dir / ".sanad", target_is_directory=True)

    file_path = temp_work_dir / "mylink" / "skills" / "x" / "SKILL.md"

    task = asyncio.create_task(write_file_tool(Params(path=str(file_path), content="pwned")))
    pending = await _await_pending(approval)
    # Classified against the real .sanad destination.
    assert pending[0].action == "edit sanad definition"

    # The attack: retarget the symlink out of .sanad while approval is pending.
    mylink.unlink()
    mylink.symlink_to(local_work_dir / "decoy", target_is_directory=True)

    approval._runtime.resolve(pending[0].id, "approve")
    result = await task
    assert not result.is_error

    # The bytes must have landed where classification captured (real .sanad),
    # NOT at the retargeted decoy destination.
    assert (sanad_target_dir / "SKILL.md").read_text() == "pwned"
    assert not (decoy_dir / "SKILL.md").exists()


# --- workspace-boundary hardening: classify EDIT vs EDIT_OUTSIDE on the RESOLVED
#     target, so a workspace symlink pointing OUTSIDE can't be auto-approved as an
#     in-workspace edit under the seeded default mode. ---


async def test_symlink_out_of_workspace_classifies_edit_outside(
    write_file_tool: WriteFile, temp_work_dir: KaosPath, approval: Approval, tmp_path
):
    """A workspace symlink whose target is OUTSIDE the workspace must classify
    EDIT_OUTSIDE (gated), never EDIT (which default mode auto-approves)."""
    import pathlib

    local_work_dir = temp_work_dir.unsafe_to_local_path()
    # A real directory outside the workspace root entirely.
    outside = pathlib.Path(tmp_path) / "outside_ws"
    outside.mkdir(parents=True, exist_ok=True)
    escape = local_work_dir / "escape"
    escape.symlink_to(outside, target_is_directory=True)

    file_path = temp_work_dir / "escape" / "loot.txt"

    task = asyncio.create_task(write_file_tool(Params(path=str(file_path), content="x")))
    pending = await _await_pending(approval)
    assert len(pending) == 1
    # The write lands at outside/loot.txt, so it must be gated as EDIT_OUTSIDE,
    # not the auto-approvable in-workspace EDIT.
    assert pending[0].action == "edit file outside of working directory"
    approval._runtime.resolve(pending[0].id, "approve")

    result = await task
    assert not result.is_error
    assert (outside / "loot.txt").read_text() == "x"
