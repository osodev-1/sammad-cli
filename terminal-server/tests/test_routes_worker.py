"""Worker runs P0: flag-gated /internal/worker/* — bundle containment, budget
clamping, NDJSON turn streaming, and same-runId+sendId replay."""

import json
import sys
from pathlib import Path

from fastapi.testclient import TestClient
from sanad_terminal.app import create_app
from sanad_terminal.settings import TerminalSettings

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
