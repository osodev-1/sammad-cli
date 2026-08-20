"""A minimal stand-in for `sanad --wire --session <id>` used in tests.

Modes are keyed on the prompt text:
- default:        TurnBegin + TextPart, then finish.
- "HANG":         TurnBegin, then the turn stays open until a cancel arrives
                  (the wall-clock-budget and cancel paths).
- "STEPHANG:<n>": n StepBegin events, then hang until cancel (step budget).
- "ASK_APPROVAL": emits a JSON-RPC `request` (ApprovalRequest shape), waits
                  for the client's response line, echoes it back as a
                  RequestOutcome event, then finishes — the deny-by-default
                  round-trip proof.
- "ASK_TOOLCALL": emits a JSON-RPC `request` (ToolCallRequest shape) — the
                  bridge does not handle this type, so it proves the
                  reject-unknown-types path even once approvals are bridged.
- "ASK_QUESTION": emits a JSON-RPC `request` (QuestionRequest shape), waits
                  for the client's response line, echoes it back as a
                  RequestOutcome event, then finishes — the question bridge
                  round-trip proof.

Outside the prompt loop, `set_permission_mode` is handled directly (mirrors
the real CLI: a StatusUpdate event first, then the success response) —
`WireRunner.call()` is a standalone request/response, not tied to a turn.
Any other unknown top-level method is silently ignored (no response), which
is what proves `call()`'s timeout path.
"""

import json
import sys


def _write(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def _event(type_name: str, payload: dict) -> None:
    _write({"jsonrpc": "2.0", "method": "event", "params": {"type": type_name, "payload": payload}})


def _read() -> dict | None:
    raw = sys.stdin.readline()
    if not raw:
        return None
    raw = raw.strip()
    if not raw:
        return {}
    try:
        msg = json.loads(raw)
        return msg if isinstance(msg, dict) else {}
    except ValueError:
        return {}


def _hang_until_cancel(prompt_id) -> None:
    """Keep the turn open; resolve it as cancelled when the bridge says so."""
    while True:
        msg = _read()
        if msg is None:
            return
        if msg.get("method") == "cancel":
            _write({"jsonrpc": "2.0", "id": msg.get("id"), "result": {}})
            _write({"jsonrpc": "2.0", "id": prompt_id, "result": {"status": "cancelled"}})
            return


def main() -> None:
    while True:
        msg = _read()
        if msg is None:
            return
        method = msg.get("method")
        mid = msg.get("id")
        if method == "initialize":
            caps = msg.get("params", {}).get("capabilities", {})
            _write(
                {
                    "jsonrpc": "2.0",
                    "id": mid,
                    "result": {
                        "protocol_version": "1.10",
                        "server": {"name": "fake-coder", "version": "0"},
                        "capabilities": caps,
                    },
                }
            )
        elif method == "prompt":
            user_input = msg.get("params", {}).get("user_input", "")
            _event("TurnBegin", {"user_input": user_input})
            if user_input.startswith("STEPHANG:"):
                for i in range(int(user_input.split(":", 1)[1])):
                    _event("StepBegin", {"step": i})
                _hang_until_cancel(mid)
            elif "HANG" in user_input:
                _hang_until_cancel(mid)
            elif "ASK_TOOLCALL" in user_input:
                _write(
                    {
                        "jsonrpc": "2.0",
                        "id": "tc_1",
                        "method": "request",
                        "params": {
                            "type": "ToolCallRequest",
                            "payload": {"id": "tc_1", "name": "external", "arguments": "{}"},
                        },
                    }
                )
                response = _read()
                _event("RequestOutcome", {"response": response})
                _write({"jsonrpc": "2.0", "id": mid, "result": {"status": "finished"}})
            elif "ASK_APPROVAL" in user_input:
                _write(
                    {
                        "jsonrpc": "2.0",
                        "id": "req_1",
                        "method": "request",
                        "params": {
                            "type": "ApprovalRequest",
                            "payload": {
                                "id": "req_1",
                                "tool_call_id": "call_1",
                                "sender": "shell",
                                "action": "run command",
                                "description": "ls -la",
                                "display": [],
                            },
                        },
                    }
                )
                response = _read()
                _event("RequestOutcome", {"response": response})
                _write({"jsonrpc": "2.0", "id": mid, "result": {"status": "finished"}})
            elif "ASK_QUESTION" in user_input:
                _write(
                    {
                        "jsonrpc": "2.0",
                        "id": "q_1",
                        "method": "request",
                        "params": {
                            "type": "QuestionRequest",
                            "payload": {
                                "id": "q_1",
                                "tool_call_id": "call_q",
                                "questions": [
                                    {
                                        "question": "Which approach?",
                                        "header": "Approach",
                                        "options": [
                                            {"label": "A", "description": "first"},
                                            {"label": "B", "description": "second"},
                                        ],
                                        "multi_select": False,
                                    }
                                ],
                            },
                        },
                    }
                )
                response = _read()
                _event("RequestOutcome", {"response": response})
                _write({"jsonrpc": "2.0", "id": mid, "result": {"status": "finished"}})
            else:
                _event("TextPart", {"type": "text", "text": "hello from coder"})
                _write({"jsonrpc": "2.0", "id": mid, "result": {"status": "finished"}})
        elif method == "cancel":
            _write({"jsonrpc": "2.0", "id": mid, "result": {}})
        elif method == "set_permission_mode":
            mode = msg.get("params", {}).get("mode", "")
            _event("StatusUpdate", {"permission_mode": mode})
            _write(
                {
                    "jsonrpc": "2.0",
                    "id": mid,
                    "result": {"status": "ok", "permission_mode": mode},
                }
            )


if __name__ == "__main__":
    main()
