"""Worker runs P0: flag-gated /internal/worker/* — bundle containment, budget
clamping, NDJSON turn streaming, and same-runId+sendId replay."""

import gzip
import json
import sys
import time
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient
from sanad_terminal.app import create_app
from sanad_terminal.control_plane import ControlPlaneClient
from sanad_terminal.run_runner import RunRunner, get_run, put_run
from sanad_terminal.settings import TerminalSettings
from sanad_terminal.wire_runner import WireRunnerError

FAKE_WIRE = Path(__file__).parent / "_fake_worker_wire.py"

# agent.yaml fields must live under a top-level `agent:` key (kimi_cli's
# agentspec loader silently treats a flat document as an empty spec, then
# fails on the (defaulted-to-Inherit) required fields) and `tools: []` is
# explicit because `tools` has no usable default (Inherit with nothing to
# inherit from, since this spec doesn't `extend`).
BUNDLE = {
    "agent.yaml": (
        "version: '1'\nagent:\n  name: t\n  system_prompt_path: prompt.md\n  tools: []\n"
    ),
    "prompt.md": "You are a worker.",
    "worker.yaml": "interface:\n  inputs: {q: string}\n  outputs: {answer: string}\n",
}


def _body(run_id: str = "r_aaaaaaaaaaaa") -> dict:
    return {
        "runId": run_id,
        "sendId": run_id,
        "input": {"q": "hi"},
        "bundle": {"files": BUNDLE},
        "budgets": {"maxTurnSeconds": 30, "maxStepsPerTurn": 50, "maxTokensPerRun": 100000},
        "sessionToken": "sess_x",
        "traceUploadUrl": "https://s3.test/put",
    }


def _control_plane(calls: list[tuple[str, dict]] | None = None) -> ControlPlaneClient:
    """A full worker turn now runs Task 12's `on_finished` for real, which
    fires a background completion POST — `control_plane=None` here would let
    `create_app` build a real client against the real `control_plane_url`
    (defaulted to production), so a completed test turn would fire an actual
    network request at the live control plane. Inject a mock transport
    instead, same pattern as `test_routes_coder.py`'s `_control_plane`.
    Optionally records (url, json body) pairs into `calls` for tests that
    want to inspect what got reported."""
    sink = calls if calls is not None else []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content) if request.content else {}
        sink.append((str(request.url), body))
        return httpx.Response(200, json={"data": {}})

    return ControlPlaneClient("https://cp.test", "unused", transport=httpx.MockTransport(handler))


def _upload_transport(calls: list[tuple[str, bytes]] | None = None) -> httpx.MockTransport:
    """The trace-upload seam threaded through `create_app`'s
    `worker_upload_transport` -> `app.state.worker_upload_transport` ->
    `_make_on_finished`'s `upload_transport` param. Without this, a full
    worker turn whose fake wire happened to write a trace file would PUT to
    `body.trace_upload_url` (`https://s3.test/put` in `_body()`) over a REAL
    `httpx.AsyncClient` — harmless only by fixture accident (the fake wire
    never writes one, so `collect_trace()` returns `None`), not by any actual
    seam. Every route test now gets a mock here regardless, so that accident
    stops being load-bearing; `test_trace_upload_hits_the_injected_transport_
    end_to_end` is the one test that deliberately makes the fake wire write a
    trace, to exercise this for real."""
    sink = calls if calls is not None else []

    def handler(request: httpx.Request) -> httpx.Response:
        sink.append((str(request.url), request.content))
        return httpx.Response(200, text="ok")

    return httpx.MockTransport(handler)


def _make_client(
    tmp_path: Path,
    *,
    enabled: bool,
    control_plane_calls: list[tuple[str, dict]] | None = None,
    upload_calls: list[tuple[str, bytes]] | None = None,
) -> TestClient:
    settings = TerminalSettings(
        mode="task",
        fixed_user="user_1",
        agentd_token="tok",
        data_dir=tmp_path,
        spawn_argv=(sys.executable, str(FAKE_WIRE)),
        worker_enabled=enabled,
    )
    return TestClient(
        create_app(settings, _control_plane(control_plane_calls), _upload_transport(upload_calls))
    )


AUTH = {"authorization": "Bearer tok"}


class _StubRunner:
    """A duck-typed stand-in for a still-registered `RunRunner`, used to test
    `start_run`'s replay/busy-run branch in isolation from real subprocess
    timing. Task 12 wired `on_finished` for real, and its `finally` clause
    calls `drop_run` the instant a run's completion is reported — so a run
    that finished via the real fake-wire subprocess is de-registered again
    within microseconds, well before a second synchronous `TestClient.post`
    call on the same test thread reliably lands (verified empirically: the
    two-call-in-a-row version of these tests started flaking/failing once
    `on_finished` stopped being a no-op). Only implements what `start_run`'s
    `existing is not None` branch and `_stream`/`follow` touch."""

    def __init__(
        self, run_id: str, turn_id: str, send_id: str, items: list[dict[str, Any]]
    ) -> None:
        self.run_id = run_id
        self._turn_id = turn_id
        self._send_id = send_id
        self._items = items

    def turn_summary(self) -> dict[str, Any]:
        return {"turnId": self._turn_id}

    def get_turn(self, turn_id: str) -> Any:
        if turn_id != self._turn_id:
            return None
        return type("S", (), {"send_id": self._send_id})()

    async def follow(self, turn_id: str, from_seq: int = 0) -> AsyncIterator[dict[str, Any]]:
        assert turn_id == self._turn_id
        for item in self._items[from_seq:]:
            yield item

    async def stop(self) -> None:
        """App-shutdown teardown (`create_app`'s lifespan) calls `drop_run`
        on every still-registered run, which calls this."""


def test_disabled_is_404(tmp_path: Path) -> None:
    with _make_client(tmp_path, enabled=False) as c:
        r = c.post("/internal/worker/runs", json=_body(), headers=AUTH)
        assert r.status_code == 404
        assert r.json()["error"]["code"] == "worker_disabled"


def test_bad_run_id_rejected(tmp_path: Path) -> None:
    with _make_client(tmp_path, enabled=True) as c:
        r = c.post("/internal/worker/runs", json=_body("nope"), headers=AUTH)
        assert r.status_code == 400
        assert r.json()["error"]["code"] == "bad_run_id"


def test_bundle_traversal_rejected(tmp_path: Path) -> None:
    body = _body()
    body["bundle"]["files"] = {"../evil.yaml": "x", **BUNDLE}
    with _make_client(tmp_path, enabled=True) as c:
        r = c.post("/internal/worker/runs", json=body, headers=AUTH)
        assert r.status_code == 400
        assert r.json()["error"]["code"] == "bad_bundle_path"


def test_bundle_absolute_path_rejected(tmp_path: Path) -> None:
    body = _body()
    body["bundle"]["files"] = {"/etc/evil.yaml": "x", **BUNDLE}
    with _make_client(tmp_path, enabled=True) as c:
        r = c.post("/internal/worker/runs", json=body, headers=AUTH)
        assert r.status_code == 400
        assert r.json()["error"]["code"] == "bad_bundle"


def test_empty_bundle_rejected(tmp_path: Path) -> None:
    body = _body()
    body["bundle"]["files"] = {}
    with _make_client(tmp_path, enabled=True) as c:
        r = c.post("/internal/worker/runs", json=body, headers=AUTH)
        assert r.status_code == 400
        assert r.json()["error"]["code"] == "bad_bundle"


def test_missing_worker_yaml_is_bad_bundle(tmp_path: Path) -> None:
    body = _body()
    body["bundle"]["files"] = {k: v for k, v in BUNDLE.items() if k != "worker.yaml"}
    with _make_client(tmp_path, enabled=True) as c:
        r = c.post("/internal/worker/runs", json=body, headers=AUTH)
        assert r.status_code == 400
        assert r.json()["error"]["code"] == "bad_bundle"


def test_start_run_requires_auth(tmp_path: Path) -> None:
    with _make_client(tmp_path, enabled=True) as c:
        r = c.post("/internal/worker/runs", json=_body())
        assert r.status_code == 401


@pytest.mark.parametrize("key", [".", "", "sub/.."])
def test_bundle_key_normalizing_to_bundle_root_rejected(tmp_path: Path, key: str) -> None:
    """A key that resolves to the bundle directory itself (not merely outside
    it) must 400 `bad_bundle_path`, not 500 from `write_text` hitting a
    directory (`is_relative_to` alone accepts it — a path is relative to
    itself)."""
    body = _body()
    body["bundle"]["files"] = {key: "x", **BUNDLE}
    with _make_client(tmp_path, enabled=True) as c:
        r = c.post("/internal/worker/runs", json=body, headers=AUTH)
        assert r.status_code == 400, r.text
        assert r.json()["error"]["code"] == "bad_bundle_path"


def test_bundle_conflicting_file_and_directory_keys_rejected(tmp_path: Path) -> None:
    """ "a" wants to be a file; "a/b.txt" wants "a" to be a directory — must
    400, not crash `mkdir`/`write_text` with an unhandled OSError."""
    body = _body()
    body["bundle"]["files"] = {"a": "x", "a/b.txt": "y", **BUNDLE}
    with _make_client(tmp_path, enabled=True) as c:
        r = c.post("/internal/worker/runs", json=body, headers=AUTH)
        assert r.status_code == 400, r.text
        assert r.json()["error"]["code"] == "bad_bundle_path"


def test_run_streams_ndjson(tmp_path: Path) -> None:
    with _make_client(tmp_path, enabled=True) as c:
        r = c.post("/internal/worker/runs", json=_body(), headers=AUTH)
        assert r.status_code == 200
        items = [json.loads(line) for line in r.text.strip().splitlines()]
        assert items[0]["kind"] == "turn"
        assert items[-1]["kind"] in ("end", "error")


def test_trace_upload_hits_the_injected_transport_end_to_end(tmp_path: Path) -> None:
    """Positively tests the trace-upload seam (see `_upload_transport`'s
    docstring for why it was only accidentally safe before): a real full
    turn whose fake wire actually writes a `wire.jsonl` (`WRITE_TRACE` mode)
    must PUT exactly once to the injected mock, with gzip-magic-byte content,
    and the completion report must say `traceUploaded: true` — exercising
    `RunRunner.collect_trace()` end to end through the real route, not just
    through `_make_on_finished` called directly (as `test_run_completion.py`
    does with a `FakeRunner`)."""
    upload_calls: list[tuple[str, bytes]] = []
    control_plane_calls: list[tuple[str, dict]] = []
    with _make_client(
        tmp_path,
        enabled=True,
        control_plane_calls=control_plane_calls,
        upload_calls=upload_calls,
    ) as c:
        body = _body()
        body["input"] = {"q": "WRITE_TRACE"}
        r = c.post("/internal/worker/runs", json=body, headers=AUTH)
        assert r.status_code == 200
        items = [json.loads(line) for line in r.text.strip().splitlines()]
        assert items[-1]["kind"] == "end"
        assert items[-1]["status"] == "finished"

        # `on_finished` (upload + report + drop) is a background task fired
        # after the stream above already ended — wait for it deterministically
        # (see `test_repeat_request_after_completion_starts_a_fresh_run`).
        for _ in range(200):
            if get_run("r_aaaaaaaaaaaa") is None:
                break
            time.sleep(0.01)
        else:
            pytest.fail("run was never de-registered after completion")

        assert len(upload_calls) == 1
        url, content = upload_calls[0]
        assert url == "https://s3.test/put"
        assert content[:2] == b"\x1f\x8b"  # gzip magic bytes — the object IS gzip
        assert gzip.decompress(content).startswith(b'{"type": "metadata"')

        posts = [call for call in control_plane_calls if "/complete" in call[0]]
        assert len(posts) == 1
        assert posts[0][1]["status"] == "succeeded"
        assert posts[0][1]["traceUploaded"] is True


def test_replay_reuses_existing_run_when_send_id_matches(tmp_path: Path) -> None:
    """Same runId+sendId against a run that's STILL REGISTERED re-follows its
    existing journal (`_stream(existing, turn_id)`) instead of re-running —
    exercised directly against a stub runner rather than a real completed
    run, since a real run is de-registered (`drop_run`, in `on_finished`'s
    `finally`) within microseconds of finishing, well before a second
    request from the same test can reliably observe it as still-registered
    (see `_StubRunner`'s docstring)."""
    with _make_client(tmp_path, enabled=True) as c:
        items = [
            {"seq": 0, "kind": "turn", "turnId": "t_stub"},
            {"seq": 1, "kind": "event", "event": {"type": "TextPart"}},
            {"seq": 2, "kind": "end", "status": "finished"},
        ]
        put_run(_StubRunner("r_aaaaaaaaaaaa", "t_stub", "r_aaaaaaaaaaaa", items))  # type: ignore[arg-type]
        r = c.post("/internal/worker/runs", json=_body(), headers=AUTH)
        assert r.status_code == 200
        assert [json.loads(line) for line in r.text.strip().splitlines()] == items


def test_different_send_id_for_existing_run_is_409(tmp_path: Path) -> None:
    """A different sendId against a STILL REGISTERED run (its current turn's
    sendId doesn't match) is a conflict — see `test_replay_...` above for why
    this drives a stub runner rather than a real completed one."""
    with _make_client(tmp_path, enabled=True) as c:
        put_run(_StubRunner("r_aaaaaaaaaaaa", "t_stub", "original-send-id", []))  # type: ignore[arg-type]
        body = _body()
        body["sendId"] = "different"
        r2 = c.post("/internal/worker/runs", json=body, headers=AUTH)
        assert r2.status_code == 409
        assert r2.json()["error"]["code"] == "busy_run"


def test_repeat_request_after_completion_starts_a_fresh_run(tmp_path: Path) -> None:
    """Documents the real, intentional P0 consequence of Task 12's immediate
    `drop_run`: once a run has finished, uploaded its trace, and reported its
    outcome, it's gone from the registry — a caller that repeats the exact
    same runId+sendId afterward does NOT get 409 `busy_run` or a replay, it
    just starts a brand new run under the same id (a fresh turnId; the P0
    design accepts this because the original caller already received the
    complete stream, including the terminal item, before `on_finished` (and
    therefore `drop_run`) ever runs)."""
    with _make_client(tmp_path, enabled=True) as c:
        r1 = c.post("/internal/worker/runs", json=_body(), headers=AUTH)
        assert r1.status_code == 200
        turn1 = json.loads(r1.text.strip().splitlines()[0])["turnId"]
        # `on_finished` (and therefore `drop_run`) runs as a background task
        # AFTER the StreamingResponse above already finished — its landing
        # isn't ordered against this test thread's next line, so wait for it
        # deterministically instead of racing it (both directions of that
        # race are exactly what broke the two tests above before they were
        # rewritten onto `_StubRunner`).
        for _ in range(200):
            if get_run("r_aaaaaaaaaaaa") is None:
                break
            time.sleep(0.01)
        else:
            pytest.fail("run was never de-registered after completion")
        r2 = c.post("/internal/worker/runs", json=_body(), headers=AUTH)
        assert r2.status_code == 200
        turn2 = json.loads(r2.text.strip().splitlines()[0])["turnId"]
        assert turn1 != turn2


def test_follow_unknown_run_is_404(tmp_path: Path) -> None:
    with _make_client(tmp_path, enabled=True) as c:
        r = c.get("/internal/worker/runs/r_bbbbbbbbbbbb/follow", headers=AUTH)
        assert r.status_code == 404
        assert r.json()["error"]["code"] == "unknown_run"


def test_cancel_unknown_run_is_404(tmp_path: Path) -> None:
    with _make_client(tmp_path, enabled=True) as c:
        r = c.post("/internal/worker/runs/r_bbbbbbbbbbbb/cancel", headers=AUTH)
        assert r.status_code == 404
        assert r.json()["error"]["code"] == "unknown_run"


def test_follow_and_cancel_require_auth(tmp_path: Path) -> None:
    with _make_client(tmp_path, enabled=True) as c:
        assert c.get("/internal/worker/runs/r_bbbbbbbbbbbb/follow").status_code == 401
        assert c.post("/internal/worker/runs/r_bbbbbbbbbbbb/cancel").status_code == 401


def test_start_turn_failure_deregisters_the_run(tmp_path: Path, monkeypatch) -> None:
    """`RunRunner.start()` can succeed (subprocess spawned, handshake done)
    while `start_turn()` then fails — e.g. the child exited right after
    `initialize`. The route must not leave that dead runner registered:
    `runners_hold_machine` would keep reporting the machine busy for it, and
    every retry of the same runId would 409 `busy_run` forever since
    `get_run` would keep finding a turn-less entry. Forcing this cheaply
    through the fake wire isn't practical (the child doesn't know at
    `initialize` time whether it should exit — the only per-request signal is
    the prompt text, sent later, by `start_turn` itself); a class-level
    monkeypatch of `start_turn` after the real handshake exercises the same
    route branch directly."""

    async def _boom(self, user_input, send_id=None):  # noqa: ANN001, ARG001
        raise WireRunnerError("not_started", "agent is not running")

    monkeypatch.setattr(RunRunner, "start_turn", _boom)
    with _make_client(tmp_path, enabled=True) as c:
        r = c.post("/internal/worker/runs", json=_body(), headers=AUTH)
        assert r.status_code == 409
        assert r.json()["error"]["code"] == "not_started"
        assert get_run("r_aaaaaaaaaaaa") is None

        # Un-poison the id: a retry with the real start_turn must succeed,
        # not 409 forever.
        monkeypatch.undo()
        r2 = c.post("/internal/worker/runs", json=_body(), headers=AUTH)
        assert r2.status_code == 200
