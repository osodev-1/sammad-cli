"""Task 12: `_make_on_finished` — trace upload + completion report.

Drives the real closure directly against a `FakeRunner` + `httpx.MockTransport`
(no real subprocess, no real network) — the same harness shape the task brief
prescribes, adapted in two ways once the brief's literal snippet was checked
against the real code it's testing:

- `RunStartBody`'s Python attributes are its own field names (`run_id`,
  `trace_upload_url`), never the `Field(alias=...)` camelCase wire name, even
  with `populate_by_name=True` (verified directly against the installed
  pydantic before writing this — a `type("B", (), {"runId": ...})()` stub, as
  a literal transcription of the brief's snippet would have it, does not
  match what `start_run` actually hands `_make_on_finished` in production).
- The PUT body is the gzip-compressed trace, not JSON — a handler that
  unconditionally does `json.loads(request.content)` (as the brief's snippet
  does) raises `UnicodeDecodeError` on the gzip magic bytes before it ever
  gets to record the call.
"""

import gzip
import json
from pathlib import Path
from typing import Any

import httpx
from sanad_terminal.control_plane import ControlPlaneClient
from sanad_terminal.routes_worker import _make_on_finished
from sanad_terminal.run_runner import get_run, prepare_run_dirs, put_run


class FakeRunner:
    run_id = "r_cccccccccccc"

    def __init__(
        self, terminal_item: dict[str, Any] | None, trace: bytes | None = b'{"type":"metadata"}\n'
    ) -> None:
        self._terminal = terminal_item
        self._trace = trace

    def terminal_item(self) -> dict[str, Any] | None:
        return self._terminal

    def usage_totals(self) -> dict[str, Any]:
        return {"tokensIn": 10, "tokensOut": 5, "modelAlias": "kimi-k3"}

    async def collect_trace(self) -> bytes | None:
        return gzip.compress(self._trace) if self._trace is not None else None

    async def stop(self) -> None:
        """`drop_run` (called from `_on_finished`'s `finally`) always calls
        `runner.stop()` after popping the registry entry — a real RunRunner
        method this fake stands in for when it's been registered via
        `put_run` for a de-registration assertion."""


def _body(trace_upload_url: str = "https://s3.test/put") -> Any:
    # Duck-typed stand-in for RunStartBody — only the two attributes
    # `_make_on_finished` actually reads, named the way a real RunStartBody
    # instance exposes them (its own field names, not the wire aliases).
    return type(
        "B", (), {"trace_upload_url": trace_upload_url, "run_id": FakeRunner.run_id}
    )()


def _mock_transport(
    calls: list[tuple[str, str, Any]],
    *,
    put_status: int = 200,
    post_status: int = 200,
) -> httpx.MockTransport:
    """Records every request as (method, url, parsed-json-or-raw-bytes) and
    answers PUT (trace upload, gzip body) and POST (completion report, JSON
    body) with the given status codes."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "PUT":
            calls.append((request.method, str(request.url), request.content))
            return httpx.Response(put_status, text="ok" if put_status < 300 else "upload failed")
        payload = json.loads(request.content) if request.content else {}
        calls.append((request.method, str(request.url), payload))
        if post_status >= 300:
            return httpx.Response(
                post_status, json={"error": {"code": "internal", "message": "boom"}}
            )
        return httpx.Response(post_status, json={"data": {}})

    return httpx.MockTransport(handler)


def _harness(
    tmp_path: Path,
    output: dict | None,
    *,
    put_status: int = 200,
    post_status: int = 200,
    agentd_token: str = "tok",
):
    calls: list[tuple[str, str, Any]] = []
    transport = _mock_transport(calls, put_status=put_status, post_status=post_status)
    cp = ControlPlaneClient("https://cp.test", "secret", transport=transport)
    dirs = prepare_run_dirs(tmp_path, FakeRunner.run_id)
    if output is not None:
        dirs.output_file.write_text(json.dumps(output))
    body = _body()
    on_finished = _make_on_finished(
        dirs, body, agentd_token=agentd_token, control_plane=cp, upload_transport=transport
    )
    return on_finished, calls, dirs


async def test_success_reports_output_and_uploads(tmp_path: Path) -> None:
    on_finished, calls, dirs = _harness(tmp_path, {"answer": "42"})
    runner = FakeRunner({"kind": "end", "status": "finished"})
    put_run(runner)  # type: ignore[arg-type]
    await on_finished(runner)  # type: ignore[arg-type]
    puts = [c for c in calls if c[0] == "PUT"]
    posts = [c for c in calls if c[0] == "POST" and "/runs/" in c[1]]
    assert len(puts) == 1
    assert posts[0][2]["status"] == "succeeded"
    assert posts[0][2]["output"] == {"answer": "42"}
    assert posts[0][2]["traceUploaded"] is True
    assert posts[0][2]["tokensIn"] == 10
    assert posts[0][2]["tokensOut"] == 5
    assert posts[0][2]["modelAlias"] == "kimi-k3"
    assert "errorCode" not in posts[0][2]
    assert not dirs.root.exists()  # cleaned on success
    assert get_run(FakeRunner.run_id) is None  # de-registered


async def test_no_output_fails_fast(tmp_path: Path) -> None:
    on_finished, calls, dirs = _harness(tmp_path, None)
    runner = FakeRunner({"kind": "end", "status": "finished"})
    await on_finished(runner)  # type: ignore[arg-type]
    post = next(c for c in calls if c[0] == "POST" and "/runs/" in c[1])
    assert post[2]["status"] == "failed"
    assert post[2]["errorCode"] == "no_output"
    assert "output" not in post[2]
    assert dirs.root.exists()  # kept for debugging


async def test_budget_error_maps_through(tmp_path: Path) -> None:
    item = {"kind": "error", "code": "turn_budget_exceeded", "message": "m"}
    on_finished, calls, _dirs = _harness(tmp_path, None)
    runner = FakeRunner(item)
    await on_finished(runner)  # type: ignore[arg-type]
    post = next(c for c in calls if c[0] == "POST" and "/runs/" in c[1])
    assert post[2] == {**post[2], "status": "failed", "errorCode": "turn_budget_exceeded"}


async def test_cancelled_end_maps_to_cancelled(tmp_path: Path) -> None:
    """The real shape a token-budget trip (or an explicit /cancel) produces:
    `_trip_budget` journals the `error` item first, but the wire's own `end`
    (status cancelled) follows once the cancel completes and becomes the
    turn's TRUE last item — `terminal_item()` returns that, not the earlier
    error. The overall run status must still come out `cancelled`, not
    `failed`/`no_output` (there was never going to be an output file for a
    cancelled run)."""
    on_finished, calls, _dirs = _harness(tmp_path, None)
    runner = FakeRunner({"kind": "end", "status": "cancelled"})
    await on_finished(runner)  # type: ignore[arg-type]
    post = next(c for c in calls if c[0] == "POST" and "/runs/" in c[1])
    assert post[2]["status"] == "cancelled"
    assert "errorCode" not in post[2]
    assert "output" not in post[2]


async def test_upload_failure_reports_trace_uploaded_false(tmp_path: Path) -> None:
    on_finished, calls, _dirs = _harness(tmp_path, {"answer": "42"}, put_status=500)
    runner = FakeRunner({"kind": "end", "status": "finished"})
    await on_finished(runner)  # type: ignore[arg-type]
    puts = [c for c in calls if c[0] == "PUT"]
    post = next(c for c in calls if c[0] == "POST" and "/runs/" in c[1])
    assert len(puts) == 1  # the attempt was made
    assert post[2]["status"] == "succeeded"  # the run itself still succeeded
    assert post[2]["traceUploaded"] is False


async def test_report_failure_is_logged_not_raised(tmp_path: Path) -> None:
    on_finished, calls, dirs = _harness(tmp_path, {"answer": "42"}, post_status=500)
    runner = FakeRunner({"kind": "end", "status": "finished"})
    put_run(runner)  # type: ignore[arg-type]
    await on_finished(runner)  # does not raise despite the 500  # type: ignore[arg-type]
    posts = [c for c in calls if c[0] == "POST" and "/runs/" in c[1]]
    assert len(posts) == 1  # the attempt was made
    assert get_run(FakeRunner.run_id) is None  # still de-registered (finally)
    # Cleanup is keyed on the run's own outcome (succeeded), not on whether
    # the control plane accepted the report — a rejected/failed report still
    # means the local dir is safe to reclaim.
    assert not dirs.root.exists()


async def test_no_agentd_token_skips_report_without_raising(tmp_path: Path) -> None:
    """Railway mode (or any machine that never got AGENTD_TOKEN): the
    factory still runs end to end, but `report_run_completion` logs and
    skips rather than sending a bearer-less request."""
    on_finished, calls, dirs = _harness(tmp_path, {"answer": "42"}, agentd_token="")
    runner = FakeRunner({"kind": "end", "status": "finished"})
    put_run(runner)  # type: ignore[arg-type]
    await on_finished(runner)  # type: ignore[arg-type]
    posts = [c for c in calls if c[0] == "POST" and "/runs/" in c[1]]
    assert posts == []  # no attempt made at all — no token to send
    puts = [c for c in calls if c[0] == "PUT"]
    assert len(puts) == 1  # trace upload is independent of the report skip
    assert not dirs.root.exists()  # still cleaned up (status was succeeded)
    assert get_run(FakeRunner.run_id) is None  # still de-registered
