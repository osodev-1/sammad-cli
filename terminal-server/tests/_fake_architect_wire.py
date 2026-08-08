"""A minimal stand-in for `sanad --wire --agent architect` used in tests.

Speaks just enough of the wire JSON-RPC protocol to exercise the bridge without
an LLM: initialize handshake, then for each prompt it emits a couple of event
frames — including a ToolResult carrying a drafted blueprint plan in
extras.blueprintPlan — and finishes the turn.
"""

import json
import sys


def _write(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def _event(type_name: str, payload: dict) -> None:
    _write({"jsonrpc": "2.0", "method": "event", "params": {"type": type_name, "payload": payload}})


def main() -> None:
    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        try:
            msg = json.loads(raw)
        except ValueError:
            continue
        method = msg.get("method")
        mid = msg.get("id")
        if method == "initialize":
            _write(
                {
                    "jsonrpc": "2.0",
                    "id": mid,
                    "result": {
                        "protocol_version": "1.10",
                        "server": {"name": "fake-architect", "version": "0"},
                        "capabilities": {"supports_question": False},
                    },
                }
            )
        elif method == "prompt":
            _event("TurnBegin", {"user_input": msg.get("params", {}).get("user_input", "")})
            _event("TextPart", {"type": "text", "text": "Here is a plan to add a skill."})
            _event(
                "ToolResult",
                {
                    "tool_call_id": "call_1",
                    "return_value": {
                        "is_error": False,
                        "output": "Create Skill “Review”",
                        "message": "Drafted a change plan.",
                        "display": [],
                        "extras": {
                            "blueprintPlan": {
                                "summary": "Create Skill “Review”",
                                "operations": [
                                    {
                                        "op": "create",
                                        "path": ".sanad/skills/review/skill.yaml",
                                        "content": "kind: Skill\n",
                                    }
                                ],
                                "preconditions": [{".sanad/skills/review/skill.yaml": None}],
                                "graphDelta": {
                                    "nodesAdded": ["skill:review"],
                                    "edgesAdded": [],
                                },
                            }
                        },
                    },
                },
            )
            _write({"jsonrpc": "2.0", "id": mid, "result": {"status": "finished"}})
        elif method == "cancel":
            _write({"jsonrpc": "2.0", "id": mid, "result": {}})
        # ignore anything else


if __name__ == "__main__":
    main()
