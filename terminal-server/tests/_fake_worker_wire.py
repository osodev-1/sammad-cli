"""A minimal stand-in for `sanad --wire` used in RunRunner tests.

Modes are keyed on the prompt text:
- default:        TurnBegin + one event + writes `{"answer": "fake"}` to
                   `$KIMI_WORKER_OUTPUT_FILE` (if set), then finishes — so
                   runner tests exercise the output-file path without a real
                   model.
- "HANG":          TurnBegin, then the turn stays open until a cancel arrives
                   (the wall-clock-budget and cancel paths).
- "STEPHANG:<n>":  n StepBegin events, then hang until cancel (step budget).
- "TOKENS:<n>":    emits one StatusUpdate event whose token_usage totals `n`
                   output tokens, then hangs until cancel (the token-budget
                   path: the runner is expected to trip and cancel it).
- "TOKENS_THEN_FINISH:<n>": emits the same over-budget StatusUpdate but does
                   NOT hang — it finishes the turn immediately afterward, the
                   same scheduling slice a late `_trip_budget` task could
                   otherwise race against (the "over-budget event was the
                   run's last one" case that must NOT retroactively mark a
                   successful run as budget-exceeded).
"""

import json
import os
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


def _write_output_file() -> None:
    path = os.environ.get("KIMI_WORKER_OUTPUT_FILE")
    if not path:
        return
    with open(path, "w") as f:
        json.dump({"answer": "fake"}, f)


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
                        "server": {"name": "fake-worker", "version": "0"},
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
            elif user_input.startswith("TOKENS_THEN_FINISH:"):
                # No output-file write here (unlike the default path): that's
                # a real disk I/O syscall, and the gap it introduces between
                # the two stdout writes is enough for the server's reader
                # loop to yield in between them — which gives a scheduled
                # trip task room to interleave BEFORE the `finished` response
                # is even read, defeating the point of this mode (both
                # messages must land in the same read so the runner processes
                # them in the same scheduling slice, same as a real model
                # emitting a final StatusUpdate immediately before its
                # response completes).
                n = int(user_input.split(":", 1)[1])
                _event(
                    "StatusUpdate",
                    {"token_usage": {"input_other": 0, "output": n}},
                )
                _write({"jsonrpc": "2.0", "id": mid, "result": {"status": "finished"}})
            elif user_input.startswith("TOKENS:"):
                n = int(user_input.split(":", 1)[1])
                _event(
                    "StatusUpdate",
                    {"token_usage": {"input_other": 0, "output": n}},
                )
                _hang_until_cancel(mid)
            elif "HANG" in user_input:
                _hang_until_cancel(mid)
            else:
                _event("TextPart", {"type": "text", "text": "hello from worker"})
                _write_output_file()
                _write({"jsonrpc": "2.0", "id": mid, "result": {"status": "finished"}})
        elif method == "cancel":
            _write({"jsonrpc": "2.0", "id": mid, "result": {}})


if __name__ == "__main__":
    main()
