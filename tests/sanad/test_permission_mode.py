"""Tests for the ``set_permission_mode`` wire method and mode-managed approvals.

Three layers, per the P2a Task 5 brief:
  - jsonrpc: the new message parses valid modes and rejects "yolo"
  - ``Approval.apply_permission_mode``: the mode -> auto_approve_actions matrix
  - ``WireServer._handle_set_permission_mode``: plan-mode delegation in both
    directions, ``StatusUpdate`` emission, dispatch registration
"""

from __future__ import annotations

from pathlib import Path
from typing import Literal

import pytest
from kosong.tooling.empty import EmptyToolset
from pydantic import ValidationError

from kimi_cli.soul.agent import Agent, Runtime
from kimi_cli.soul.approval import MODE_MANAGED_ACTIONS, Approval, ApprovalState
from kimi_cli.soul.context import Context
from kimi_cli.soul.kimisoul import KimiSoul
from kimi_cli.wire.jsonrpc import (
    JSONRPC_IN_METHODS,
    JSONRPCInMessageAdapter,
    JSONRPCSetPermissionModeMessage,
    JSONRPCSuccessResponse,
)
from kimi_cli.wire.jsonrpc import _SetPermissionModeParams as SetPermissionModeParams
from kimi_cli.wire.protocol import WIRE_PROTOCOL_VERSION
from kimi_cli.wire.server import WireServer
from kimi_cli.wire.types import StatusUpdate

_PermissionMode = Literal["default", "accept-edits", "plan"]


def _msg(mode: _PermissionMode) -> JSONRPCSetPermissionModeMessage:
    return JSONRPCSetPermissionModeMessage(id="1", params=SetPermissionModeParams(mode=mode))


def _make_soul(runtime: Runtime, tmp_path: Path) -> KimiSoul:
    agent = Agent(
        name="Permission Mode Test Agent",
        system_prompt="Test prompt.",
        toolset=EmptyToolset(),
        runtime=runtime,
    )
    return KimiSoul(agent, context=Context(file_backend=tmp_path / "history.jsonl"))


class TestProtocolVersion:
    def test_bumped_to_1_11(self) -> None:
        assert WIRE_PROTOCOL_VERSION == "1.11"


class TestSetPermissionModeJsonRpc:
    def test_parses_accept_edits(self) -> None:
        msg = JSONRPCInMessageAdapter.validate_python(
            {"method": "set_permission_mode", "id": "1", "params": {"mode": "accept-edits"}}
        )
        assert isinstance(msg, JSONRPCSetPermissionModeMessage)
        assert msg.params.mode == "accept-edits"

    @pytest.mark.parametrize("mode", ["default", "accept-edits", "plan"])
    def test_parses_every_valid_mode(self, mode: str) -> None:
        msg = JSONRPCInMessageAdapter.validate_python(
            {"method": "set_permission_mode", "id": "1", "params": {"mode": mode}}
        )
        assert isinstance(msg, JSONRPCSetPermissionModeMessage)
        assert msg.params.mode == mode

    def test_rejects_yolo(self) -> None:
        with pytest.raises(ValidationError):
            JSONRPCInMessageAdapter.validate_python(
                {"method": "set_permission_mode", "id": "1", "params": {"mode": "yolo"}}
            )

    def test_registered_in_in_methods(self) -> None:
        assert "set_permission_mode" in JSONRPC_IN_METHODS


class TestApplyPermissionMode:
    def test_default_replaces_managed_actions_and_forces_yolo_false(self) -> None:
        changes: list[bool] = []
        state = ApprovalState(
            yolo=True,
            auto_approve_actions={"run command (git)", "edit file outside of working directory"},
            on_change=lambda: changes.append(True),
        )
        approval = Approval(state=state)

        approval.apply_permission_mode("default")

        assert state.auto_approve_actions == {"run command (git)", "edit file"}
        assert state.yolo is False
        assert changes == [True]

    def test_accept_edits_adds_both_edit_actions_and_forces_yolo_false(self) -> None:
        changes: list[bool] = []
        state = ApprovalState(
            yolo=True,
            auto_approve_actions={"run command (git)", "edit file outside of working directory"},
            on_change=lambda: changes.append(True),
        )
        approval = Approval(state=state)

        approval.apply_permission_mode("accept-edits")

        assert state.auto_approve_actions == {
            "run command (git)",
            "edit file",
            "edit file outside of working directory",
        }
        assert state.yolo is False
        assert changes == [True]

    def test_survives_unrelated_entries(self) -> None:
        state = ApprovalState(auto_approve_actions={"run command (npm test)", "read file"})
        approval = Approval(state=state)

        approval.apply_permission_mode("default")

        assert "run command (npm test)" in state.auto_approve_actions
        assert "read file" in state.auto_approve_actions

    def test_mode_managed_actions_matches_file_actions_literals(self) -> None:
        # Duplicated literals must stay in sync with kimi_cli.tools.file.FileActions
        # (EDIT / EDIT_OUTSIDE) without importing tools from soul.
        assert frozenset({"edit file", "edit file outside of working directory"}) == (
            MODE_MANAGED_ACTIONS
        )


@pytest.mark.asyncio
class TestHandleSetPermissionMode:
    async def test_default_mode_updates_approvals_and_emits_status(
        self, runtime: Runtime, tmp_path: Path
    ) -> None:
        state = ApprovalState(
            yolo=True,
            auto_approve_actions={"run command (git)", "edit file outside of working directory"},
        )
        runtime.approval = Approval(state=state)
        soul = _make_soul(runtime, tmp_path)
        server = WireServer(soul)

        sent: list = []
        original_send = server._send_msg

        async def capture(msg):
            sent.append(msg)
            await original_send(msg)

        server._send_msg = capture  # type: ignore[method-assign]

        response = await server._handle_set_permission_mode(
            _msg("accept-edits")
        )

        assert isinstance(response, JSONRPCSuccessResponse)
        assert response.result == {"status": "ok", "permission_mode": "accept-edits"}
        assert state.yolo is False
        assert state.auto_approve_actions == {
            "run command (git)",
            "edit file",
            "edit file outside of working directory",
        }

        status_events = [m.params for m in sent if isinstance(getattr(m, "params", None), StatusUpdate)]
        assert len(status_events) == 1
        assert status_events[0].permission_mode == "accept-edits"
        assert status_events[0].plan_mode is False

    async def test_plan_mode_delegates_to_set_plan_mode(
        self, runtime: Runtime, tmp_path: Path
    ) -> None:
        soul = _make_soul(runtime, tmp_path)
        server = WireServer(soul)
        assert soul.plan_mode is False

        response = await server._handle_set_permission_mode(
            _msg("plan")
        )

        assert isinstance(response, JSONRPCSuccessResponse)
        assert response.result == {"status": "ok", "permission_mode": "plan"}
        assert soul.plan_mode is True

    async def test_default_mode_turns_off_active_plan_mode_first(
        self, runtime: Runtime, tmp_path: Path
    ) -> None:
        soul = _make_soul(runtime, tmp_path)
        server = WireServer(soul)
        await soul.set_plan_mode_from_manual(True)
        assert soul.plan_mode is True

        response = await server._handle_set_permission_mode(
            _msg("default")
        )

        assert isinstance(response, JSONRPCSuccessResponse)
        assert soul.plan_mode is False
        assert "edit file" in soul.runtime.approval._state.auto_approve_actions

    async def test_accept_edits_mode_turns_off_active_plan_mode_first(
        self, runtime: Runtime, tmp_path: Path
    ) -> None:
        soul = _make_soul(runtime, tmp_path)
        server = WireServer(soul)
        await soul.set_plan_mode_from_manual(True)

        response = await server._handle_set_permission_mode(
            _msg("accept-edits")
        )

        assert isinstance(response, JSONRPCSuccessResponse)
        assert soul.plan_mode is False
        assert "edit file outside of working directory" in soul.runtime.approval._state.auto_approve_actions

    async def test_rejects_when_soul_is_not_kimi_soul(self, runtime: Runtime) -> None:
        from kimi_cli.wire.jsonrpc import ErrorCodes
        from kimi_cli.wire.server import JSONRPCErrorResponse

        class _NotKimiSoul:
            pass

        server = WireServer.__new__(WireServer)
        server._soul = _NotKimiSoul()  # type: ignore[assignment]

        response = await server._handle_set_permission_mode(
            _msg("default")
        )

        assert isinstance(response, JSONRPCErrorResponse)
        assert response.error.code == ErrorCodes.INVALID_STATE

    async def test_dispatch_routes_set_permission_mode(
        self, runtime: Runtime, tmp_path: Path
    ) -> None:
        soul = _make_soul(runtime, tmp_path)
        server = WireServer(soul)

        sent: list = []

        async def capture(msg):
            sent.append(msg)

        server._send_msg = capture  # type: ignore[method-assign]

        await server._dispatch_msg(
            _msg("default")
        )

        results = [m for m in sent if isinstance(m, JSONRPCSuccessResponse)]
        assert len(results) == 1
        assert results[0].result == {"status": "ok", "permission_mode": "default"}
