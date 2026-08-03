#!/usr/bin/env python3
"""A zero-dependency local stand-in for the sanad control plane + gateway.

For hands-on testing of the sanad CLI without the full TypeScript backend
(no Postgres/Redis/docker). It implements just the endpoints the CLI calls:

  POST /api/v1/auth/device/start   -> device code (auto-approves on poll)
  POST /api/v1/auth/device/poll    -> completes immediately with a session token
  GET  /api/v1/auth/me             -> demo identity
  POST /api/v1/auth/logout         -> 204
  POST /api/v1/runtime-tokens      -> mint (gateway_base_url points back here)
  POST /api/v1/runtime-tokens/renew  -> new expiry
  POST /api/v1/runtime-tokens/revoke -> 204
  POST /v1/chat/completions        -> OpenAI-compatible streamed canned reply

This is a DEMO fake: it does no real auth and issues non-secret tokens. It is
not the product and must never be used outside a local sandbox.

    python scripts/demo_backend.py            # listens on 127.0.0.1:4101
    SANAD_DEMO_PORT=4200 python scripts/demo_backend.py
"""

from __future__ import annotations

import json
import os
from datetime import UTC, datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("SANAD_DEMO_PORT", "4101"))
HOST = "127.0.0.1"


def _iso(delta_seconds: int = 0) -> str:
    return (datetime.now(UTC) + timedelta(seconds=delta_seconds)).isoformat().replace("+00:00", "Z")


class Handler(BaseHTTPRequestHandler):
    server_version = "sanad-demo/0"

    # -- helpers ----------------------------------------------------------
    def _send(self, status: int, payload: dict | None) -> None:
        body = b"" if payload is None else json.dumps(payload).encode()
        self.send_response(status)
        if body:
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def _data(self, data: object, status: int = 200) -> None:
        self._send(status, {"data": data, "meta": {"requestId": "demo"}})

    def _read_json(self) -> dict:
        length = int(self.headers.get("content-length", "0") or "0")
        if not length:
            return {}
        try:
            return json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            return {}

    def log_message(self, fmt: str, *args: object) -> None:  # quieter logs
        return

    # -- routes -----------------------------------------------------------
    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/health":
            self._data({"status": "ok"})
        elif self.path == "/api/v1/auth/me":
            self._data(
                {
                    "userId": "demo-user",
                    "organizationId": "demo-org",
                    "membershipId": "demo-membership",
                    "role": "owner",
                    "permissions": ["agent.run"],
                }
            )
        else:
            self._send(404, {"error": {"code": "not_found", "message": self.path}})

    def do_POST(self) -> None:  # noqa: N802
        body = self._read_json()
        if self.path == "/api/v1/auth/device/start":
            self._data(
                {
                    "deviceAuthId": "demo-device",
                    "userCode": "SANAD-DEMO",
                    "verificationUri": f"http://{HOST}:{PORT}/device",
                    "verificationUriComplete": f"http://{HOST}:{PORT}/device?code=SANAD-DEMO",
                    "expiresAt": _iso(600),
                    "pollIntervalSeconds": 1,
                },
                status=201,
            )
        elif self.path == "/api/v1/auth/device/poll":
            # Auto-approve: the very first poll already completes.
            self._data(
                {
                    "status": "complete",
                    "cliSessionToken": "demo-session-token",
                    "user": {"id": "demo-user", "email": "you@northwind.example"},
                    "organization": {"id": "demo-org", "name": "Northwind", "slug": "northwind"},
                    "membership": {"id": "demo-membership", "role": "owner"},
                }
            )
        elif self.path == "/api/v1/auth/logout":
            self._send(204, None)
        elif self.path == "/api/v1/runtime-tokens":
            self._data(
                {
                    "token": "demo-runtime-token",
                    "tokenId": "demo-rtok",
                    "familyId": "demo-family",
                    "expiresAt": _iso(600),
                    "absoluteExpiresAt": _iso(24 * 3600),
                    "gatewayBaseUrl": f"http://{HOST}:{PORT}/v1",
                    # Illustrative sandbox set mirroring the real alias surface so
                    # `/model <alias>` switching is demonstrable end to end. Context
                    # sizes/capabilities are server-authored in production.
                    "modelSettings": [
                        {
                            "name": "kimi-k2.7-code",
                            "maxContextSize": 128000,
                            "capabilities": ["thinking"],
                        },
                        {"name": "gpt-5.3-codex", "maxContextSize": 200000, "capabilities": []},
                        {
                            "name": "deepseek-v4-pro",
                            "maxContextSize": 64000,
                            "capabilities": ["thinking"],
                        },
                        {"name": "codestral", "maxContextSize": 32000, "capabilities": []},
                        {"name": "mistral-small", "maxContextSize": 32000, "capabilities": []},
                    ],
                    "defaultModelAlias": "kimi-k2.7-code",
                }
            )
        elif self.path == "/api/v1/runtime-tokens/renew":
            self._data({"expiresAt": _iso(600)})
        elif self.path == "/api/v1/runtime-tokens/revoke":
            self._send(204, None)
        elif self.path.rstrip("/") == "/v1/chat/completions":
            self._stream_completion(body.get("model") or "kimi-k2.7-code")
        else:
            self._send(404, {"error": {"code": "not_found", "message": self.path}})

    def _stream_completion(self, model: str) -> None:
        chunks = [
            {"delta": {"role": "assistant"}},
            {"delta": {"content": "Hello from the sanad demo gateway — "}},
            {"delta": {"content": "your governed session is working."}},
            {"delta": {}, "finish_reason": "stop"},
        ]
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.end_headers()
        for c in chunks:
            frame = {
                "id": "demo",
                "object": "chat.completion.chunk",
                "model": model,
                "choices": [{"index": 0, **c}],
            }
            self.wfile.write(f"data: {json.dumps(frame)}\n\n".encode())
            self.wfile.flush()
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()


def main() -> None:
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"sanad demo backend on http://{HOST}:{PORT}  (Ctrl-C to stop)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
