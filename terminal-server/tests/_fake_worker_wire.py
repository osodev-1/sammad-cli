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
- "WRITE_TRACE":   same as default (output file + finished), but ALSO writes
                   a plausible `$KIMI_SHARE_DIR/sessions/<workdir-basename>/
                   <session-id>/wire.jsonl` — the layout `RunRunner.
                   collect_trace()` globs for — so a route-level test can
                   exercise the real trace-upload PUT end to end instead of
                   relying on the fixture's usual silence there (every OTHER
                   mode deliberately writes nothing under KIMI_SHARE_DIR, so
                   `collect_trace()` returns None for them by design — this
                   is the one opt-in exception).
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


def _arg_after(flag: str) -> str | None:
    argv = sys.argv
    if flag in argv:
        idx = argv.index(flag)
        if idx + 1 < len(argv):
            return argv[idx + 1]
    return None


def _write_trace_file() -> None:
    """Mirror the real CLI's session-journal layout closely enough for
    `RunRunner.collect_trace()`'s glob to find it: `$KIMI_SHARE_DIR/sessions/
    <workdir-basename>/<session-id>/wire.jsonl`. `--session <id>` and
    `--work-dir <path>` are both real argv `routes_worker.py` always passes
    (see the `argv` list it builds), so this reads them back rather than
    needing a dedicated env var just for the fixture."""
    share_dir = os.environ.get("KIMI_SHARE_DIR")
    session_id = _arg_after("--session")
    if not share_dir or not session_id:
        return
    work_dir = _arg_after("--work-dir") or "workspace"
    basename = os.path.basename(work_dir.rstrip("/")) or "workspace"
    session_dir = os.path.join(share_dir, "sessions", basename, session_id)
    os.makedirs(session_dir, exist_ok=True)
    with open(os.path.join(session_dir, "wire.jsonl"), "w") as f:
        f.write(json.dumps({"type": "metadata", "session_id": session_id}) + "\n")
        f.write(json.dumps({"type": "turn_begin"}) + "\n")


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
            elif "WRITE_TRACE" in user_input:
                _event("TextPart", {"type": "text", "text": "hello from worker"})
                _write_output_file()
                _write_trace_file()
                _write({"jsonrpc": "2.0", "id": mid, "result": {"status": "finished"}})
            else:
                _event("TextPart", {"type": "text", "text": "hello from worker"})
                _write_output_file()
                _write({"jsonrpc": "2.0", "id": mid, "result": {"status": "finished"}})
        elif method == "cancel":
            _write({"jsonrpc": "2.0", "id": mid, "result": {}})


if __name__ == "__main__":
    main()
