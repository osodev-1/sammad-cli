"""Worker runs P0: flag-gated /internal/worker/* — bundle containment, budget
clamping, NDJSON turn streaming, and same-runId+sendId replay."""

import json
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sanad_terminal.app import create_app
from sanad_terminal.run_runner import RunRunner, get_run
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
        "runId": run_id, "sendId": run_id, "input": {"q": "hi"},
        "bundle": {"files": BUNDLE},
        "budgets": {"maxTurnSeconds": 30, "maxStepsPerTurn": 50, "maxTokensPerRun": 100000},
        "sessionToken": "sess_x", "traceUploadUrl": "https://s3.test/put",
    }


def _make_client(tmp_path: Path, *, enabled: bool) -> TestClient:
    settings = TerminalSettings(
        mode="task",
        fixed_user="user_1",
        agentd_token="tok",
        data_dir=tmp_path,
        spawn_argv=(sys.executable, str(FAKE_WIRE)),
        worker_enabled=enabled,
    )
    return TestClient(create_app(settings, control_plane=None))


AUTH = {"authorization": "Bearer tok"}


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
    """"a" wants to be a file; "a/b.txt" wants "a" to be a directory — must
    400, not crash `mkdir`/`write_text` with an unhandled OSError."""
    body = _body()
    body["bundle"]["files"] = {"a": "x", "a/b.txt": "y", **BUNDLE}
    with _make_client(tmp_path, enabled=True) as c:
        r = c.post("/internal/worker/runs", json=body, headers=AUTH)
        assert r.status_code == 400, r.text
        assert r.json()["error"]["code"] == "bad_bundle_path"


def test_run_streams_ndjson_and_replays_by_send_id(tmp_path: Path) -> None:
    with _make_client(tmp_path, enabled=True) as c:
        r = c.post("/internal/worker/runs", json=_body(), headers=AUTH)
        assert r.status_code == 200
        items = [json.loads(line) for line in r.text.strip().splitlines()]
        assert items[0]["kind"] == "turn"
        assert items[-1]["kind"] in ("end", "error")
        # replay: same runId+sendId re-follows instead of 409
        r2 = c.post("/internal/worker/runs", json=_body(), headers=AUTH)
        assert r2.status_code == 200
        items2 = [json.loads(line) for line in r2.text.strip().splitlines()]
        assert items2 == items


def test_different_send_id_for_existing_run_is_409(tmp_path: Path) -> None:
    with _make_client(tmp_path, enabled=True) as c:
        r = c.post("/internal/worker/runs", json=_body(), headers=AUTH)
        assert r.status_code == 200
        body = _body()
        body["sendId"] = "different"
        r2 = c.post("/internal/worker/runs", json=body, headers=AUTH)
        assert r2.status_code == 409
        assert r2.json()["error"]["code"] == "busy_run"


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
