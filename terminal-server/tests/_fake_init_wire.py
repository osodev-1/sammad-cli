"""A minimal stand-in for ANY `sanad --wire ...` agent, purpose-built to
control exactly what the `initialize` handshake answers with — the P6b
propagation logic in `WireRunner.start()` lives entirely in how it parses
THAT one response, so this is deliberately agent-agnostic (used to construct
a bare `WireRunner`, `ArchitectRunner`, or `RunRunner` alike — none of them
override `start()`).

Controlled by env vars (never argv — `WireRunner` doesn't expose a way to
pass extra argv through to a fake for tests, and env is already how real
agent config reaches the child):

- `FAKE_INIT_MODE` unset or "ok": respond to `initialize` with an ordinary
  success result, then idle (read and ignore anything further).
- `FAKE_INIT_MODE=error`: respond to `initialize` with the JSON-RPC `error`
  object given verbatim in `FAKE_INIT_ERROR_JSON` (a JSON-encoded dict).
- `FAKE_INIT_MODE=hang`: never respond to `initialize` at all — proves the
  timeout path (`start()`'s own `_INIT_TIMEOUT_SECONDS`, monkeypatched down
  in tests so this doesn't actually wait 30s).
"""

import json
import os
import sys


def _write(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def main() -> None:
    mode = os.environ.get("FAKE_INIT_MODE", "ok")
    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        try:
            msg = json.loads(raw)
        except ValueError:
            continue
        if msg.get("method") != "initialize":
            continue
        mid = msg.get("id")
        if mode == "hang":
            continue  # never answer — the caller's own timeout must fire
        if mode == "error":
            error = json.loads(os.environ["FAKE_INIT_ERROR_JSON"])
            _write({"jsonrpc": "2.0", "id": mid, "error": error})
            return
        _write(
            {
                "jsonrpc": "2.0",
                "id": mid,
                "result": {
                    "protocol_version": "1.11",
                    "server": {"name": "fake-init", "version": "0"},
                    "capabilities": {},
                },
            }
        )
        # Idle after a successful init — read (and ignore) anything further
        # so the subprocess doesn't exit and trip the "agent exited" path.
        for _ in sys.stdin:
            pass
        return


if __name__ == "__main__":
    main()
