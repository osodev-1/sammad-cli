from __future__ import annotations

import asyncio
import contextlib
import json
from pathlib import Path
from typing import Any, Literal, cast

import acp  # type: ignore[reportMissingTypeStubs]
import pydantic
from kosong.chat_provider import APIStatusError, ChatProviderError
from kosong.tooling import ToolError, ToolResult
from kosong.utils.typing import JsonType

from kimi_cli.approval_runtime import ApprovalRuntime
from kimi_cli.constant import USER_AGENT
from kimi_cli.sanad.session_lease import HeartbeatAction, build_takeover_notification
from kimi_cli.sanad.session_lease import decide_heartbeat_action as _decide_lease_action
from kimi_cli.sanad.session_lease import holder_id as _lease_holder_id
from kimi_cli.sanad.session_lock import (
    HEARTBEAT_SECONDS,
    heartbeat,
    locks_enabled,
    read_owner,
    release,
    try_acquire,
)
from kimi_cli.soul import LLMNotSet, LLMNotSupported, MaxStepsReached, RunCancelled, Soul, run_soul
from kimi_cli.soul.kimisoul import KimiSoul
from kimi_cli.soul.toolset import KimiToolset, WireExternalTool
from kimi_cli.utils.aioqueue import Queue, QueueShutDown
from kimi_cli.utils.logging import logger
from kimi_cli.utils.signals import install_sigint_handler
from kimi_cli.wire import Wire
from kimi_cli.wire.types import (
    ApprovalRequest,
    ApprovalResponse,
    HookRequest,
    HookResponse,
    QuestionNotSupported,
    QuestionRequest,
    QuestionResponse,
    Request,
    StatusUpdate,
    ToolCallRequest,
    is_event,
    is_request,
)

from .jsonrpc import (
    ClientInfo,
    ErrorCodes,
    JSONRPCCancelMessage,
    JSONRPCErrorObject,
    JSONRPCErrorResponse,
    JSONRPCErrorResponseNullableID,
    JSONRPCEventMessage,
    JSONRPCInitializeMessage,
    JSONRPCInMessage,
    JSONRPCInMessageAdapter,
    JSONRPCMessage,
    JSONRPCOutMessage,
    JSONRPCPromptMessage,
    JSONRPCReplayMessage,
    JSONRPCRequestMessage,
    JSONRPCSetPermissionModeMessage,
    JSONRPCSetPlanModeMessage,
    JSONRPCSteerMessage,
    JSONRPCSuccessResponse,
    Statuses,
)

# Maximum buffer size for the asyncio StreamReader used for stdio.
# Passed as the `limit` argument to `acp.stdio_streams`, this caps how much
# data can be buffered when reading from stdin (e.g., large tool or model
# outputs sent over JSON-RPC). A 100MB limit is large enough for typical
# interactive use while still protecting the process from unbounded memory
# growth or buffer-overrun errors when peers send unexpectedly large payloads.
STDIO_BUFFER_LIMIT = 100 * 1024 * 1024


def _is_oauth_session(runtime: Any) -> bool:
    """Return True if the current session uses OAuth-based authentication."""
    if runtime is None:
        return False
    llm = getattr(runtime, "llm", None)
    if llm is None:
        return False
    provider_config = getattr(llm, "provider_config", None)
    if provider_config is None:
        return False
    return getattr(provider_config, "oauth", None) is not None


class WireServer:
    def __init__(self, soul: Soul):
        self._reader: asyncio.StreamReader | None = None
        self._writer: asyncio.StreamWriter | None = None

        # outward
        self._write_task: asyncio.Task[None] | None = None
        self._write_queue: Queue[JSONRPCOutMessage] = Queue()

        # inward
        self._dispatch_tasks: set[asyncio.Task[None]] = set()

        # soul running stuffs
        self._soul = soul
        self._cancel_event: asyncio.Event | None = None
        self._pending_requests: dict[str, Request] = {}
        """Maps JSON RPC message IDs to pending `Request`s."""
        self._client_supports_question: bool = False
        """Whether the Wire client supports QuestionRequest."""
        self._client_supports_plan_mode: bool = False
        """Whether the Wire client supports plan mode."""
        self._initialized: bool = False
        self._root_hub_queue: Queue[Any] | None = None
        self._root_hub_task: asyncio.Task[None] | None = None

        # P6b: session lease. `stop_event` is promoted to instance state
        # (was local to `serve()`) so the heartbeat task below can trigger
        # the existing `_shutdown()` from outside `serve()`'s own frame.
        self._stop_event: asyncio.Event | None = None
        self._lease_session_dir: Path | None = None
        self._lease_holder: str | None = None
        self._lease_generation: int | None = None
        self._lease_task: asyncio.Task[None] | None = None

    @property
    def _approval_runtime(self) -> ApprovalRuntime | None:
        if isinstance(self._soul, KimiSoul):
            return self._soul.runtime.approval_runtime
        return None

    async def serve(self) -> None:
        logger.info("Starting Wire server on stdio")

        self._reader, self._writer = await acp.stdio_streams(limit=STDIO_BUFFER_LIMIT)
        self._write_task = asyncio.create_task(self._write_loop())
        if isinstance(self._soul, KimiSoul) and self._soul.runtime.root_wire_hub is not None:
            self._root_hub_queue = self._soul.runtime.root_wire_hub.subscribe()
            self._root_hub_task = asyncio.create_task(self._root_hub_loop())
        self._stop_event = asyncio.Event()
        stop_event = self._stop_event
        self._start_lease_heartbeat()
        loop = asyncio.get_running_loop()
        remove_sigint = install_sigint_handler(loop, stop_event.set)
        read_task = asyncio.create_task(self._read_loop())
        stop_task = asyncio.create_task(stop_event.wait())
        tasks: set[asyncio.Task[Any]] = {read_task, stop_task}
        pending = tasks
        try:
            done, pending = await asyncio.wait(
                tasks,
                return_when=asyncio.FIRST_COMPLETED,
            )
            if stop_event.is_set():
                logger.info("Wire server interrupted, shutting down")
                if self._cancel_event is not None:
                    self._cancel_event.set()
                if not read_task.done():
                    read_task.cancel()
                    with contextlib.suppress(asyncio.CancelledError):
                        await read_task
            elif read_task in done:
                read_task.result()
        except KeyboardInterrupt:
            logger.info("Wire server interrupted, shutting down")
            if self._cancel_event is not None:
                self._cancel_event.set()
        finally:
            remove_sigint()
            for task in pending:
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await task
            await self._shutdown()

    async def _root_hub_loop(self) -> None:
        assert self._root_hub_queue is not None
        while True:
            try:
                msg = await self._root_hub_queue.get()
            except QueueShutDown:
                return
            try:
                if not self._initialized:
                    continue
                if isinstance(msg, ApprovalRequest):
                    await self._request_approval(msg)
                elif isinstance(msg, ApprovalResponse):
                    self._pending_requests.pop(msg.request_id, None)
                    await self._send_msg(JSONRPCEventMessage(method="event", params=msg))
                elif is_event(msg):
                    await self._send_msg(JSONRPCEventMessage(method="event", params=msg))
            except Exception:
                logger.exception("Root hub message handling failed")

    async def _write_loop(self) -> None:
        assert self._writer is not None

        try:
            while True:
                try:
                    msg = await self._write_queue.get()
                except QueueShutDown:
                    logger.debug("Send queue shut down, stopping Wire server write loop")
                    break
                self._writer.write(msg.model_dump_json().encode("utf-8") + b"\n")
                await self._writer.drain()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Wire server write loop error:")
            raise

    async def _read_loop(self) -> None:
        assert self._reader is not None

        while True:
            raw_line = await self._reader.readline()
            if not raw_line:
                logger.info("stdin closed, Wire server exiting")
                break
            line = raw_line.decode("utf-8", errors="replace").strip()

            try:
                msg_json = json.loads(line)
            except ValueError:
                logger.error("Invalid JSON line: {line}", line=line)
                await self._send_msg(
                    JSONRPCErrorResponseNullableID(
                        id=None,
                        error=JSONRPCErrorObject(
                            code=ErrorCodes.PARSE_ERROR,
                            message="Invalid JSON format",
                        ),
                    )
                )
                continue

            try:
                generic_msg = JSONRPCMessage.model_validate(msg_json)
            except pydantic.ValidationError as e:
                logger.error("Invalid JSON-RPC message: {error}", error=e)
                await self._send_msg(
                    JSONRPCErrorResponseNullableID(
                        id=None,
                        error=JSONRPCErrorObject(
                            code=ErrorCodes.INVALID_REQUEST,
                            message="Invalid request",
                        ),
                    )
                )
                continue

            if generic_msg.is_response():
                # for responses, we skip the method check
                try:
                    msg = JSONRPCInMessageAdapter.validate_python(msg_json)
                except pydantic.ValidationError as e:
                    logger.error("Invalid JSON-RPC response: {error}", error=e)
                    await self._send_msg(
                        JSONRPCErrorResponseNullableID(
                            id=None,
                            error=JSONRPCErrorObject(
                                code=ErrorCodes.INVALID_REQUEST,
                                message="Invalid response",
                            ),
                        )
                    )
                    continue  # ignore invalid json-rpc responses

                if not isinstance(msg, (JSONRPCSuccessResponse, JSONRPCErrorResponse)):
                    logger.error(
                        "Invalid JSON-RPC response message: {msg}",
                        msg=msg_json,
                    )
                    continue  # ignore invalid response messages

                task = asyncio.create_task(self._dispatch_msg(msg))
                task.add_done_callback(self._dispatch_tasks.discard)
                self._dispatch_tasks.add(task)
                continue

            if not generic_msg.method_is_inbound():
                logger.error(
                    "Unexpected JSON-RPC method received: {method}",
                    method=generic_msg.method,
                )
                if generic_msg.id is not None:
                    resp = JSONRPCErrorResponse(
                        id=generic_msg.id,
                        error=JSONRPCErrorObject(
                            code=ErrorCodes.METHOD_NOT_FOUND,
                            message=f"Unexpected method received: {generic_msg.method}",
                        ),
                    )
                    await self._send_msg(resp)
                continue  # ignore unexpected outbound methods

            try:
                msg = JSONRPCInMessageAdapter.validate_python(msg_json)
            except pydantic.ValidationError as e:
                logger.error("Invalid JSON-RPC inbound message: {error}", error=e)
                if generic_msg.id is not None:
                    resp = JSONRPCErrorResponse(
                        id=generic_msg.id,
                        error=JSONRPCErrorObject(
                            code=ErrorCodes.INVALID_PARAMS,
                            message=f"Invalid parameters for method `{generic_msg.method}`",
                        ),
                    )
                    await self._send_msg(resp)
                continue  # ignore invalid inbound messages

            task = asyncio.create_task(self._dispatch_msg(msg))
            task.add_done_callback(self._dispatch_tasks.discard)
            self._dispatch_tasks.add(task)

    async def _shutdown(self) -> None:
        # Review fix (Important 3): the lease cancel+release now lives in
        # this `finally`, so it ALWAYS runs — even if something above it
        # raises (e.g. `_write_task`; see the broadened suppress below,
        # which already prevents the most likely case, but the `finally`
        # is the actual guarantee, not that suppress). Without this, an
        # abruptly-disconnected client could leak `owner.json` for up to
        # `STALE_AFTER_SECONDS`, with the user told "already open in the
        # browser" the whole time. Placing the lease code in `finally`
        # ALSO means that on the normal (non-exceptional) path it runs
        # right after `asyncio.gather(*self._dispatch_tasks, ...)` below —
        # i.e. after a cancelled in-flight turn has actually finished
        # unwinding/flushing, not while it's still in progress, so a
        # successor can't acquire and start writing into the same
        # `context.jsonl`/`state.json` this process hasn't finished with.
        try:
            for request in self._pending_requests.values():
                if request.resolved:
                    continue
                match request:
                    case ApprovalRequest():
                        if request.source_kind == "foreground_turn":
                            request.resolve("reject")
                            if self._approval_runtime is not None:
                                self._approval_runtime.resolve(request.id, "reject")
                    case ToolCallRequest():
                        request.resolve(
                            ToolError(
                                message="Wire connection closed before tool result was received.",
                                brief="Wire closed",
                            )
                        )
                    case QuestionRequest():
                        request.resolve({})
                    case HookRequest():
                        request.resolve("allow")
            self._pending_requests.clear()

            if self._cancel_event is not None:
                self._cancel_event.set()
                self._cancel_event = None

            self._write_queue.shutdown()
            if self._write_task is not None:
                # Review fix (Important 3): `_write_loop` re-raises real
                # exceptions after logging them (e.g. a broken pipe on
                # `drain()`) — suppressing only `CancelledError` here let
                # that exception propagate out of `_shutdown()` and skip
                # everything below (root hub cleanup, the dispatch gather,
                # and — before this fix — the lease release). Already
                # logged inside `_write_loop`; nothing is lost by not
                # re-raising it a second time here.
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await self._write_task

            if self._root_hub_task is not None:
                self._root_hub_task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await self._root_hub_task
                self._root_hub_task = None
            if (
                isinstance(self._soul, KimiSoul)
                and self._root_hub_queue is not None
                and self._soul.runtime.root_wire_hub is not None
            ):
                self._soul.runtime.root_wire_hub.unsubscribe(self._root_hub_queue)
                self._root_hub_queue = None

            await asyncio.gather(*self._dispatch_tasks, return_exceptions=True)
            self._dispatch_tasks.clear()
        finally:
            # P6b: session lease. Cancel the heartbeat task FIRST — it is
            # the only other caller of `try_acquire` in this process (the
            # REFUSE_STEAL self-reacquire below) — so no acquire can
            # possibly race the release that follows.
            if self._lease_task is not None:
                self._lease_task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await self._lease_task
                self._lease_task = None
            if self._lease_session_dir is not None and self._lease_holder is not None:
                release(
                    self._lease_session_dir,
                    holder=self._lease_holder,
                    generation=self._lease_generation,
                )
                self._lease_session_dir = None
                self._lease_holder = None

        if self._writer is not None:
            self._writer.close()
            with contextlib.suppress(Exception):
                await self._writer.wait_closed()
            self._writer = None

        self._reader = None
        self._initialized = False

    def _start_lease_heartbeat(self) -> None:
        """P6b: start the ~10s session-lease heartbeat, IF the gate is on.

        Deliberately checked here (not left to `heartbeat()`'s own internal
        gate) so that gate-off means no task is ever created at all — not
        merely a task that immediately no-ops. `session.dir` is safe to
        call again here: it already exists (created back in `cli/__init__.py`
        at acquire time; `Session.dir` is `mkdir(parents=True,
        exist_ok=True)`-idempotent regardless).
        """
        if not locks_enabled() or not isinstance(self._soul, KimiSoul):
            return
        session_dir = self._soul.runtime.session.dir
        holder = _lease_holder_id("wire")
        # The acquire that granted (or refused) this run already happened in
        # cli/__init__.py, before `KimiCLI.create()`. Read back what it
        # wrote so `release()` later has the right fencing generation,
        # without threading a new parameter through `KimiCLI.create()` /
        # `run_wire_stdio()` / `WireServer.__init__`.
        owner = read_owner(session_dir)
        generation = owner.generation if owner is not None and owner.holder == holder else None

        self._lease_session_dir = session_dir
        self._lease_holder = holder
        self._lease_generation = generation
        self._lease_task = asyncio.create_task(self._lease_heartbeat_loop())

    async def _lease_heartbeat_loop(self) -> None:
        """Thin `sleep; tick` wrapper. All the actual decision/action logic
        lives in `_lease_heartbeat_tick`, which does no sleeping, so it can
        be awaited directly in a test without a real 10s wait."""
        while True:
            await asyncio.sleep(HEARTBEAT_SECONDS)
            if await self._lease_heartbeat_tick() is HeartbeatAction.STAND_DOWN:
                return

    async def _lease_heartbeat_tick(self) -> HeartbeatAction:
        """One heartbeat: refresh `owner.json`, decide, act. No sleeping."""
        assert self._lease_session_dir is not None
        assert self._lease_holder is not None
        session_dir = self._lease_session_dir
        holder = self._lease_holder

        busy = self._is_streaming
        result = heartbeat(session_dir, holder=holder, busy=busy)
        action = _decide_lease_action(result, busy=busy)

        if action is HeartbeatAction.REFUSE_STEAL:
            # Mid-turn: do NOT detach. Self-reacquire (idempotent for our
            # own holder id — see `try_acquire`) clears `steal_requested_by`
            # so the taker learns it was refused instead of hanging on a
            # steal that will never be granted.
            reacquired = try_acquire(session_dir, holder=holder, ui_mode="wire")
            if reacquired.ok:
                if reacquired.owner is not None:
                    self._lease_generation = reacquired.owner.generation
            else:
                # Review fix (M10): between `heartbeat()`'s read/write
                # above and this self-reacquire, someone else genuinely
                # seized the lease — `try_acquire` only ever refuses a
                # self-reacquire when a LIVE, DIFFERENT holder is now on
                # record. Treat this exactly like STAND_DOWN instead of
                # tracking the OTHER holder's generation.
                action = HeartbeatAction.STAND_DOWN

        if action is HeartbeatAction.STAND_DOWN:
            # Either genuinely lost the lease, a cooperative steal request
            # landed while idle, or the REFUSE_STEAL branch just
            # discovered (above) that it was actually already too late.
            logger.warning(
                "Session lease lost/reclaimed for {dir}; wire view standing down",
                dir=session_dir,
            )
            self._publish_takeover_notification()
            assert self._stop_event is not None
            self._stop_event.set()

        return action

    def _publish_takeover_notification(self) -> None:
        """Tell OUR OWN connected wire client (agentd -> browser panel) why
        this connection is about to close. `_root_hub_loop` already
        forwards any `is_event(msg)` published on `root_wire_hub` to the
        client with no code change needed there — `Notification` is already
        in the `Event` union (see `build_takeover_notification`)."""
        if not isinstance(self._soul, KimiSoul) or self._soul.runtime.root_wire_hub is None:
            return
        with contextlib.suppress(Exception):
            self._soul.runtime.root_wire_hub.publish_nowait(
                build_takeover_notification(ui_mode="wire")
            )

    async def _dispatch_msg(self, msg: JSONRPCInMessage) -> None:
        resp: JSONRPCSuccessResponse | JSONRPCErrorResponse | None = None
        try:
            match msg:
                case JSONRPCInitializeMessage():
                    resp = await self._handle_initialize(msg)
                case JSONRPCPromptMessage():
                    resp = await self._handle_prompt(msg)
                case JSONRPCReplayMessage():
                    resp = await self._handle_replay(msg)
                case JSONRPCSteerMessage():
                    resp = await self._handle_steer(msg)
                case JSONRPCSetPlanModeMessage():
                    resp = await self._handle_set_plan_mode(msg)
                case JSONRPCSetPermissionModeMessage():
                    resp = await self._handle_set_permission_mode(msg)
                case JSONRPCCancelMessage():
                    resp = await self._handle_cancel(msg)
                case JSONRPCSuccessResponse() | JSONRPCErrorResponse():
                    await self._handle_response(msg)

            if resp is not None:
                await self._send_msg(resp)
        except Exception:
            logger.exception("Unexpected error dispatching JSONRPC message:")
            raise

    async def _send_msg(self, msg: JSONRPCOutMessage) -> None:
        try:
            await self._write_queue.put(msg)
        except QueueShutDown:
            logger.error("Send queue shut down; dropping message: {msg}", msg=msg)

    @property
    def _is_streaming(self) -> bool:
        return self._cancel_event is not None

    async def _handle_initialize(
        self, msg: JSONRPCInitializeMessage
    ) -> JSONRPCSuccessResponse | JSONRPCErrorResponse:
        if self._is_streaming:
            return JSONRPCErrorResponse(
                id=msg.id,
                error=JSONRPCErrorObject(
                    code=ErrorCodes.INVALID_STATE,
                    message="An agent turn is already in progress",
                ),
            )

        accepted: list[str] = []
        rejected: list[dict[str, str]] = []
        toolset = None
        if isinstance(self._soul, KimiSoul) and isinstance(self._soul.agent.toolset, KimiToolset):
            toolset = self._soul.agent.toolset

        if toolset and msg.params.external_tools:
            for tool in msg.params.external_tools:
                existing = toolset.find(tool.name)
                if existing is not None and not isinstance(existing, WireExternalTool):
                    rejected.append({"name": tool.name, "reason": "conflicts with builtin tool"})
                    continue
                ok, reason = toolset.register_external_tool(
                    tool.name,
                    tool.description,
                    tool.parameters,
                )
                if ok:
                    accepted.append(tool.name)
                else:
                    rejected.append({"name": tool.name, "reason": reason or "invalid schema"})

        slash_commands: list[JsonType] = []
        for cmd in self._soul.available_slash_commands:
            slash_commands.append(
                cast(
                    JsonType,
                    {"name": cmd.name, "description": cmd.description, "aliases": cmd.aliases},
                )
            )

        from kimi_cli.constant import NAME, VERSION
        from kimi_cli.hooks.config import HOOK_EVENT_TYPES
        from kimi_cli.hooks.engine import WireHookHandle, WireHookSubscription
        from kimi_cli.soul import wire_send
        from kimi_cli.wire.protocol import WIRE_PROTOCOL_VERSION
        from kimi_cli.wire.types import HookResolved, HookTriggered

        # Hook engine setup — register wire subscriptions and callbacks

        hook_engine = self._soul.hook_engine

        if msg.params.hooks:
            wire_subs: list[WireHookSubscription] = []
            for wh in msg.params.hooks:
                if wh.event not in HOOK_EVENT_TYPES:
                    logger.warning("Ignoring unknown hook event from client: {}", wh.event)
                    continue
                wire_subs.append(
                    WireHookSubscription(
                        id=wh.id,
                        event=wh.event,
                        matcher=wh.matcher,
                        timeout=wh.timeout,
                    )
                )
            if wire_subs:
                hook_engine.add_wire_subscriptions(wire_subs)
                logger.info("Registered {} wire hook subscriptions from client", len(wire_subs))

        def _on_triggered(event: str, target: str, count: int) -> None:
            wire_send(HookTriggered(event=event, target=target, hook_count=count))

        def _on_resolved(
            event: str,
            target: str,
            action: str,
            reason: str,
            duration_ms: int,
        ) -> None:
            wire_send(
                HookResolved(
                    event=event,
                    target=target,
                    action=cast(Literal["allow", "block"], action),
                    reason=reason,
                    duration_ms=duration_ms,
                )
            )

        async def _on_wire_hook(handle: WireHookHandle) -> None:
            """Send HookRequest to client, wire response back to handle."""
            request = HookRequest(
                id=handle.id,
                subscription_id=handle.subscription_id,
                event=handle.event,
                target=handle.target,
                input_data=handle.input_data,
            )
            self._pending_requests[handle.id] = request
            await self._send_msg(JSONRPCRequestMessage(id=handle.id, params=request))
            # Wait for client response (resolved via _handle_response)
            action, reason = await request.wait()
            handle.resolve(action, reason)

        hook_engine.set_callbacks(
            on_triggered=_on_triggered,
            on_resolved=_on_resolved,
            on_wire_hook=_on_wire_hook,
        )

        hooks_info: dict[str, JsonType] = cast(
            dict[str, JsonType],
            {
                "supported_events": HOOK_EVENT_TYPES,
                "configured": hook_engine.summary,
            },
        )

        result: dict[str, JsonType] = {
            "protocol_version": WIRE_PROTOCOL_VERSION,
            "server": cast(JsonType, {"name": NAME, "version": VERSION}),
            "slash_commands": cast(JsonType, slash_commands),
        }
        if accepted or rejected:
            result["external_tools"] = cast(
                JsonType,
                {
                    "accepted": accepted,
                    "rejected": rejected,
                },
            )

        if hooks_info:
            result["hooks"] = cast(JsonType, hooks_info)

        self._apply_wire_client_info(msg.params.client)
        self._track_session_started(msg.params.client)

        if msg.params.capabilities is not None:
            self._client_supports_question = msg.params.capabilities.supports_question
            self._client_supports_plan_mode = msg.params.capabilities.supports_plan_mode

        if toolset is not None:
            self._sync_ask_user_tool_visibility(toolset)
            self._sync_plan_mode_tool_visibility(toolset)

        self._initialized = True
        if self._approval_runtime is not None:
            for request in self._approval_runtime.list_pending():
                await self._request_approval(
                    ApprovalRequest(
                        id=request.id,
                        tool_call_id=request.tool_call_id,
                        sender=request.sender,
                        action=request.action,
                        description=request.description,
                        display=request.display,
                        source_kind=request.source.kind,
                        source_id=request.source.id,
                        agent_id=request.source.agent_id,
                        subagent_type=request.source.subagent_type,
                    )
                )

        result["capabilities"] = cast(
            JsonType,
            {"supports_question": True},
        )

        return JSONRPCSuccessResponse(
            id=msg.id,
            result=result,
        )

    def _sync_ask_user_tool_visibility(self, toolset: KimiToolset) -> None:
        """Hide or unhide the AskUserQuestion tool based on client capabilities."""
        from kimi_cli.tools.ask_user import NAME as ASK_USER_TOOL_NAME

        all_toolsets = [toolset]

        if self._client_supports_question:
            for ts in all_toolsets:
                ts.unhide(ASK_USER_TOOL_NAME)
        else:
            for ts in all_toolsets:
                ts.hide(ASK_USER_TOOL_NAME)
            logger.info(
                "Hid {tool} tool: client does not support questions",
                tool=ASK_USER_TOOL_NAME,
            )

    def _sync_plan_mode_tool_visibility(self, toolset: KimiToolset) -> None:
        """Hide or unhide plan mode tools based on client capabilities."""
        from kimi_cli.tools.plan import NAME as EXIT_PLAN_MODE_TOOL_NAME
        from kimi_cli.tools.plan.enter import NAME as ENTER_PLAN_MODE_TOOL_NAME

        plan_tool_names = [ENTER_PLAN_MODE_TOOL_NAME, EXIT_PLAN_MODE_TOOL_NAME]

        all_toolsets = [toolset]

        if self._client_supports_plan_mode:
            for ts in all_toolsets:
                for name in plan_tool_names:
                    ts.unhide(name)
        else:
            for ts in all_toolsets:
                for name in plan_tool_names:
                    ts.hide(name)
            logger.info(
                "Hide plan mode tools: client does not support plan mode",
            )

    def _apply_wire_client_info(self, client: ClientInfo | None) -> None:
        if client is not None:
            from kimi_cli.telemetry import set_client_info

            set_client_info(name=client.name, version=client.version)

        if not isinstance(self._soul, KimiSoul):
            return
        llm = self._soul.runtime.llm
        if llm is None:
            return

        ua_suffix = ""
        if client is not None:
            ua_suffix = client.name
            if client.version:
                ua_suffix += f" {client.version}"
            ua_suffix = f" ({ua_suffix.strip()})"

        from kosong.chat_provider.kimi import Kimi

        if isinstance(llm.chat_provider, Kimi):
            kimi_client = llm.chat_provider.client
            headers = dict(kimi_client._custom_headers)  # pyright: ignore[reportPrivateUsage]
            headers["User-Agent"] = f"{USER_AGENT}{ua_suffix}"
            kimi_client._custom_headers = headers  # pyright: ignore[reportPrivateUsage]

    def _track_session_started(self, client: ClientInfo | None) -> None:
        if not isinstance(self._soul, KimiSoul):
            return

        from kimi_cli.telemetry import track_session_started_once

        track_session_started_once(
            ui_mode="wire",
            resumed=self._soul.runtime.resumed,
            client_name=client.name if client is not None else None,
            client_version=client.version if client is not None else None,
        )

    async def _handle_prompt(
        self, msg: JSONRPCPromptMessage
    ) -> JSONRPCSuccessResponse | JSONRPCErrorResponse:
        if self._is_streaming:
            # TODO: support queueing multiple inputs
            return JSONRPCErrorResponse(
                id=msg.id,
                error=JSONRPCErrorObject(
                    code=ErrorCodes.INVALID_STATE, message="An agent turn is already in progress"
                ),
            )

        if not self._initialized:
            self._track_session_started(None)

        self._cancel_event = asyncio.Event()
        runtime = self._soul.runtime if isinstance(self._soul, KimiSoul) else None
        try:
            await run_soul(
                self._soul,
                msg.params.user_input,
                self._stream_wire_messages,
                self._cancel_event,
                runtime.session.wire_file if runtime else None,
                runtime,
            )
            return JSONRPCSuccessResponse(
                id=msg.id,
                result={"status": Statuses.FINISHED},
            )
        except LLMNotSet:
            return JSONRPCErrorResponse(
                id=msg.id,
                error=JSONRPCErrorObject(code=ErrorCodes.LLM_NOT_SET, message="LLM is not set"),
            )
        except LLMNotSupported as e:
            return JSONRPCErrorResponse(
                id=msg.id,
                error=JSONRPCErrorObject(code=ErrorCodes.LLM_NOT_SUPPORTED, message=str(e)),
            )
        except APIStatusError as e:
            if e.status_code == 401 and _is_oauth_session(runtime):
                return JSONRPCErrorResponse(
                    id=msg.id,
                    error=JSONRPCErrorObject(
                        code=ErrorCodes.AUTH_EXPIRED,
                        message=(
                            "Authentication failed. Your login session may have expired. "
                            'Please run "/login" to sign in again.'
                        ),
                    ),
                )
            return JSONRPCErrorResponse(
                id=msg.id,
                error=JSONRPCErrorObject(code=ErrorCodes.CHAT_PROVIDER_ERROR, message=str(e)),
            )
        except ChatProviderError as e:
            return JSONRPCErrorResponse(
                id=msg.id,
                error=JSONRPCErrorObject(code=ErrorCodes.CHAT_PROVIDER_ERROR, message=str(e)),
            )
        except MaxStepsReached as e:
            return JSONRPCSuccessResponse(
                id=msg.id,
                result={"status": Statuses.MAX_STEPS_REACHED, "steps": e.n_steps},
            )
        except RunCancelled:
            return JSONRPCSuccessResponse(
                id=msg.id,
                result={"status": Statuses.CANCELLED},
            )
        except Exception as e:
            logger.exception("Unexpected error in prompt handler")
            return JSONRPCErrorResponse(
                id=msg.id,
                error=JSONRPCErrorObject(
                    code=ErrorCodes.INTERNAL_ERROR,
                    message=f"{type(e).__name__}: {e}",
                ),
            )
        finally:
            # Clean up any remaining pending requests from this turn.
            # After run_soul() returns, the soul and all subagents are done,
            # so any unresolved requests are stale.
            stale_ids = [k for k, v in self._pending_requests.items() if not v.resolved]
            for msg_id in stale_ids:
                request = self._pending_requests[msg_id]
                match request:
                    case ApprovalRequest():
                        if request.source_kind == "foreground_turn":
                            self._pending_requests.pop(msg_id, None)
                            request.resolve("reject")
                            if self._approval_runtime is not None:
                                self._approval_runtime.resolve(request.id, "reject")
                    case ToolCallRequest():
                        self._pending_requests.pop(msg_id, None)
                        request.resolve(
                            ToolError(
                                message="Agent turn ended before tool result was received.",
                                brief="Turn ended",
                            )
                        )
                    case QuestionRequest():
                        self._pending_requests.pop(msg_id, None)
                        request.resolve({})
                    case HookRequest():
                        self._pending_requests.pop(msg_id, None)
                        request.resolve("allow")
                    case _:
                        pass
            self._cancel_event = None

    async def _handle_steer(
        self, msg: JSONRPCSteerMessage
    ) -> JSONRPCSuccessResponse | JSONRPCErrorResponse:
        if not isinstance(self._soul, KimiSoul) or not self._is_streaming:
            return JSONRPCErrorResponse(
                id=msg.id,
                error=JSONRPCErrorObject(
                    code=ErrorCodes.INVALID_STATE,
                    message="No agent turn is in progress",
                ),
            )

        self._soul.steer(msg.params.user_input)
        return JSONRPCSuccessResponse(
            id=msg.id,
            result={"status": Statuses.STEERED},
        )

    async def _handle_set_plan_mode(
        self, msg: JSONRPCSetPlanModeMessage
    ) -> JSONRPCSuccessResponse | JSONRPCErrorResponse:
        if not isinstance(self._soul, KimiSoul):
            return JSONRPCErrorResponse(
                id=msg.id,
                error=JSONRPCErrorObject(
                    code=ErrorCodes.INVALID_STATE,
                    message="Plan mode is not supported",
                ),
            )

        new_state = await self._soul.set_plan_mode_from_manual(msg.params.enabled)

        status = StatusUpdate(plan_mode=new_state)
        await self._send_msg(JSONRPCEventMessage(params=status))
        # Persist to wire file so replay reconstructs plan mode state
        await self._soul.wire_file.append_message(status)
        return JSONRPCSuccessResponse(
            id=msg.id,
            result={"status": "ok", "plan_mode": new_state},
        )

    async def _handle_set_permission_mode(
        self, msg: JSONRPCSetPermissionModeMessage
    ) -> JSONRPCSuccessResponse | JSONRPCErrorResponse:
        if not isinstance(self._soul, KimiSoul):
            return JSONRPCErrorResponse(
                id=msg.id,
                error=JSONRPCErrorObject(
                    code=ErrorCodes.INVALID_STATE,
                    message="Permission modes are not supported",
                ),
            )

        mode = msg.params.mode
        if mode == "plan":
            # Plan mode itself rides the existing plan-mode machinery;
            # approvals are untouched (Approval.apply_permission_mode is not
            # involved for this branch).
            await self._soul.set_plan_mode_from_manual(True)
        else:
            # Switching to an approval posture while plan mode is on turns
            # plan mode off first, then applies the new posture.
            if self._soul.plan_mode:
                await self._soul.set_plan_mode_from_manual(False)
            self._soul.runtime.approval.apply_permission_mode(mode)

        status = StatusUpdate(permission_mode=mode, plan_mode=self._soul.plan_mode)
        await self._send_msg(JSONRPCEventMessage(params=status))
        # Persist to wire file so replay reconstructs permission mode state
        await self._soul.wire_file.append_message(status)
        return JSONRPCSuccessResponse(
            id=msg.id,
            result={"status": "ok", "permission_mode": mode},
        )

    async def _handle_replay(
        self, msg: JSONRPCReplayMessage
    ) -> JSONRPCSuccessResponse | JSONRPCErrorResponse:
        if self._is_streaming:
            return JSONRPCErrorResponse(
                id=msg.id,
                error=JSONRPCErrorObject(
                    code=ErrorCodes.INVALID_STATE, message="An agent turn is already in progress"
                ),
            )

        wire_file = self._soul.wire_file if isinstance(self._soul, KimiSoul) else None

        self._cancel_event = asyncio.Event()
        events = 0
        requests = 0
        try:
            if wire_file is None or not wire_file.path.exists():
                return JSONRPCSuccessResponse(
                    id=msg.id,
                    result={"status": Statuses.FINISHED, "events": 0, "requests": 0},
                )

            async for record in wire_file.iter_records():
                if self._cancel_event.is_set():
                    return JSONRPCSuccessResponse(
                        id=msg.id,
                        result={
                            "status": Statuses.CANCELLED,
                            "events": events,
                            "requests": requests,
                        },
                    )

                try:
                    wire_msg = record.to_wire_message()
                except Exception:
                    logger.exception(
                        "Failed to deserialize wire record for replay: {file}",
                        file=wire_file.path,
                    )
                    continue

                if is_request(wire_msg):
                    await self._send_msg(JSONRPCRequestMessage(id=wire_msg.id, params=wire_msg))
                    requests += 1
                elif is_event(wire_msg):
                    await self._send_msg(JSONRPCEventMessage(params=wire_msg))
                    events += 1
                else:
                    # Not reachable for valid WireMessage, but keep a guard for corrupted data.
                    logger.warning(
                        "Skipping non-wire message during replay: {msg}",
                        msg=wire_msg,
                    )

                await asyncio.sleep(0)  # yield control for cancel handling

            if self._cancel_event.is_set():
                return JSONRPCSuccessResponse(
                    id=msg.id,
                    result={
                        "status": Statuses.CANCELLED,
                        "events": events,
                        "requests": requests,
                    },
                )

            return JSONRPCSuccessResponse(
                id=msg.id,
                result={"status": Statuses.FINISHED, "events": events, "requests": requests},
            )
        except Exception:
            logger.exception("Replay failed:")
            return JSONRPCErrorResponse(
                id=msg.id,
                error=JSONRPCErrorObject(
                    code=ErrorCodes.INTERNAL_ERROR,
                    message="Replay failed",
                ),
            )
        finally:
            self._cancel_event = None

    async def _handle_cancel(
        self, msg: JSONRPCCancelMessage
    ) -> JSONRPCSuccessResponse | JSONRPCErrorResponse:
        if not self._is_streaming:
            return JSONRPCErrorResponse(
                id=msg.id,
                error=JSONRPCErrorObject(
                    code=ErrorCodes.INVALID_STATE, message="No agent turn is in progress"
                ),
            )

        assert self._cancel_event is not None
        self._cancel_event.set()
        return JSONRPCSuccessResponse(
            id=msg.id,
            result={},
        )

    async def _handle_response(self, msg: JSONRPCSuccessResponse | JSONRPCErrorResponse) -> None:
        request = self._pending_requests.pop(msg.id, None)
        if request is None:
            logger.error("No pending request for response id={id}", id=msg.id)
            return

        match request:
            case ApprovalRequest():
                if isinstance(msg, JSONRPCErrorResponse):
                    request.resolve("reject")
                    if self._approval_runtime is not None:
                        self._approval_runtime.resolve(request.id, "reject")
                    return

                try:
                    result = ApprovalResponse.model_validate(msg.result)
                except pydantic.ValidationError as e:
                    logger.error(
                        "Invalid response result for request id={id}: {error}",
                        id=msg.id,
                        error=e,
                    )
                    request.resolve("reject")
                    if self._approval_runtime is not None:
                        self._approval_runtime.resolve(request.id, "reject")
                    return

                if result.request_id != request.id:
                    logger.warning(
                        "Approval response id mismatch: request={request_id}, "
                        "response={response_id}",
                        request_id=request.id,
                        response_id=result.request_id,
                    )
                request.resolve(result.response)
                if self._approval_runtime is not None:
                    self._approval_runtime.resolve(
                        request.id, result.response, feedback=result.feedback
                    )
            case ToolCallRequest():
                if isinstance(msg, JSONRPCErrorResponse):
                    error = msg.error.message
                    request.resolve(
                        ToolError(
                            message=error,
                            brief="External tool error",
                        )
                    )
                    return

                try:
                    tool_result = ToolResult.model_validate(msg.result)
                except pydantic.ValidationError as e:
                    logger.error(
                        "Invalid tool result for request id={id}: {error}",
                        id=msg.id,
                        error=e,
                    )
                    request.resolve(
                        ToolError(
                            message="Invalid tool result payload from client.",
                            brief="Invalid tool result",
                        )
                    )
                    return
                if tool_result.tool_call_id != request.id:
                    logger.warning(
                        "Tool result id mismatch: request={request_id}, result={result_id}",
                        request_id=request.id,
                        result_id=tool_result.tool_call_id,
                    )
                request.resolve(tool_result.return_value)
            case QuestionRequest():
                if isinstance(msg, JSONRPCErrorResponse):
                    request.resolve({})
                    return

                try:
                    result = QuestionResponse.model_validate(msg.result)
                except pydantic.ValidationError as e:
                    logger.error(
                        "Invalid question response for request id={id}: {error}",
                        id=msg.id,
                        error=e,
                    )
                    request.resolve({})
                    return

                if result.request_id != request.id:
                    logger.warning(
                        "Question response id mismatch: request={request_id}, "
                        "response={response_id}",
                        request_id=request.id,
                        response_id=result.request_id,
                    )
                request.resolve(result.answers)
            case HookRequest():
                if isinstance(msg, JSONRPCErrorResponse):
                    request.resolve("allow")
                    return

                try:
                    result = HookResponse.model_validate(msg.result)
                except pydantic.ValidationError as e:
                    logger.error(
                        "Invalid hook response for request id={id}: {error}",
                        id=msg.id,
                        error=e,
                    )
                    request.resolve("allow")
                    return

                if result.request_id != request.id:
                    logger.warning(
                        "Hook response id mismatch: request={request_id}, response={response_id}",
                        request_id=request.id,
                        response_id=result.request_id,
                    )
                request.resolve(result.action, result.reason)

    async def _stream_wire_messages(self, wire: Wire) -> None:
        wire_ui = wire.ui_side(merge=False)
        while True:
            msg = await wire_ui.receive()
            match msg:
                case ApprovalRequest():
                    await self._request_approval(msg)
                case ToolCallRequest():
                    await self._request_external_tool(msg)
                case QuestionRequest():
                    await self._request_question(msg)
                case HookRequest():
                    pass  # handled via hook engine callbacks
                case _:
                    await self._send_msg(JSONRPCEventMessage(method="event", params=msg))

    async def _request_approval(self, request: ApprovalRequest) -> None:
        msg_id = request.id  # just use the approval request id as message id
        self._pending_requests[msg_id] = request
        await self._send_msg(JSONRPCRequestMessage(id=msg_id, params=request))
        # Do NOT await request.wait() here.  The approval future is awaited by
        # the tool that created the request (inside the soul task).  Blocking the
        # UI loop would prevent ALL subsequent Wire messages — from every
        # concurrent subagent — from reaching stdout, causing a cascade deadlock
        # when the approval response is lost (e.g. no WebSocket connected).

    async def _request_external_tool(self, request: ToolCallRequest) -> None:
        msg_id = request.id
        self._pending_requests[msg_id] = request
        await self._send_msg(JSONRPCRequestMessage(id=msg_id, params=request))
        # Same rationale as _request_approval: do not block the UI loop.

    async def _request_question(self, request: QuestionRequest) -> None:
        if not self._client_supports_question:
            # Client does not support interactive questions; signal the tool
            # so it can tell the LLM to use an alternative approach.
            request.set_exception(QuestionNotSupported())
            return
        msg_id = request.id
        self._pending_requests[msg_id] = request
        await self._send_msg(JSONRPCRequestMessage(id=msg_id, params=request))
        # Same rationale as _request_approval: do not block the UI loop.
