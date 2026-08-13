"""CLI verb tests for `kimi agent deploy/runs/logs/pause/resume` (Task 9).

Session-token resolution and the SanadClient are both injected via the
module-level seams (`_build_session`/`_build_client`) the same way
tests/sanad/test_cli.py fakes `_build_session` for the `sanad` app.
"""

from __future__ import annotations

import json
from pathlib import Path

import httpx
from typer.testing import CliRunner

from kimi_cli.cli import worker as worker_cli
from kimi_cli.sanad.client import SanadClient
from kimi_cli.sanad.session import SanadSession
from kimi_cli.sanad.settings import SanadSettings
from tests.sanad.test_session import FakeKeychain, ok

runner = CliRunner()

AGENT_YAML = "version: '1'\nagent:\n  name: t\n  system_prompt_path: prompt.md\n  tools: []\n"
WORKER_YAML = "interface:\n  inputs: {q: string}\n  outputs: {answer: string}\n"


def _write_bundle(work_dir: Path) -> None:
    (work_dir / "agent.yaml").write_text(AGENT_YAML)
    (work_dir / "prompt.md").write_text("You are a test agent.")
    (work_dir / "worker.yaml").write_text(WORKER_YAML)


def _install_client(monkeypatch, handler) -> SanadClient:
    """Client used for the actual deploy/runs/logs/pause/resume network calls."""
    client = SanadClient(
        SanadSettings(api_base_url="https://cp.test"), transport=httpx.MockTransport(handler)
    )
    monkeypatch.setattr(worker_cli, "_build_client", lambda: client)
    return client


def _install_signed_in(monkeypatch, token: str = "sess-1") -> None:
    """Session used purely for token resolution — its own client is never called."""

    def _boom(request: httpx.Request) -> httpx.Response:
        raise AssertionError("session's own client should never be called by worker verbs")

    session = SanadSession(
        client=SanadClient(
            SanadSettings(api_base_url="https://cp.test"), transport=httpx.MockTransport(_boom)
        ),
        keychain=FakeKeychain(token),  # type: ignore[arg-type]
    )
    monkeypatch.setattr(worker_cli, "_build_session", lambda: session)


def _install_signed_out(monkeypatch) -> None:
    session = SanadSession(
        client=SanadClient(SanadSettings(api_base_url="https://cp.test")),
        keychain=FakeKeychain(None),  # type: ignore[arg-type]
    )
    monkeypatch.setattr(worker_cli, "_build_session", lambda: session)


# -- deploy -------------------------------------------------------------


def test_deploy_broken_agent_yaml_exits_4_without_any_http_call(tmp_path, monkeypatch) -> None:
    called: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        called.append(request.url.path)
        return ok({})

    # Signed in (so a missing token can't be the reason we never call out) —
    # but the bundle never validates, so this handler must stay untouched.
    _install_signed_in(monkeypatch)
    _install_client(monkeypatch, handler)

    (tmp_path / "agent.yaml").write_text("not: {valid")  # invalid YAML
    (tmp_path / "worker.yaml").write_text(WORKER_YAML)

    result = runner.invoke(
        worker_cli.cli, ["deploy", "--work-dir", str(tmp_path)], catch_exceptions=False
    )

    assert result.exit_code == 4, result.output
    assert called == []


def test_deploy_missing_worker_yaml_exits_4_without_any_http_call(tmp_path, monkeypatch) -> None:
    called: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        called.append(request.url.path)
        return ok({})

    _install_signed_in(monkeypatch)
    _install_client(monkeypatch, handler)

    (tmp_path / "agent.yaml").write_text(AGENT_YAML)
    (tmp_path / "prompt.md").write_text("hi")
    # worker.yaml intentionally absent

    result = runner.invoke(
        worker_cli.cli, ["deploy", "--work-dir", str(tmp_path)], catch_exceptions=False
    )

    assert result.exit_code == 4, result.output
    assert called == []


def test_deploy_success_prints_camel_case_json(tmp_path, monkeypatch) -> None:
    _write_bundle(tmp_path)
    seen_files: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/v1/agents":
            assert json.loads(request.content) == {"name": "t", "workspace": "default"}
            return httpx.Response(200, json={"data": {"agentId": "ag_1", "name": "t"}})
        if request.url.path == "/api/v1/agents/t/versions":
            seen_files.update(json.loads(request.content)["files"])
            return httpx.Response(
                200, json={"data": {"versionId": "av_1", "contentHash": "cc" * 32}}
            )
        assert request.url.path == "/api/v1/agents/t/deployments"
        assert json.loads(request.content) == {"versionId": "av_1", "env": "dev"}
        return httpx.Response(200, json={"data": {"deploymentId": "dp_1"}})

    _install_signed_in(monkeypatch)
    _install_client(monkeypatch, handler)

    result = runner.invoke(
        worker_cli.cli, ["deploy", "--work-dir", str(tmp_path)], catch_exceptions=False
    )

    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload == {
        "agentId": "ag_1",
        "versionId": "av_1",
        "deploymentId": "dp_1",
        "contentHash": "cc" * 32,
    }
    assert seen_files == {
        "agent.yaml": AGENT_YAML,
        "worker.yaml": WORKER_YAML,
        "prompt.md": "You are a test agent.",
    }


def test_deploy_not_signed_in_exits_nonzero_without_http_call(tmp_path, monkeypatch) -> None:
    _write_bundle(tmp_path)
    called: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        called.append(request.url.path)
        return ok({})

    _install_signed_out(monkeypatch)
    _install_client(monkeypatch, handler)

    result = runner.invoke(
        worker_cli.cli, ["deploy", "--work-dir", str(tmp_path)], catch_exceptions=False
    )

    assert result.exit_code == 1, result.output
    assert called == []
    assert "not signed in" in result.output.lower()


# -- runs -----------------------------------------------------------------


def test_runs_table_renders_cost_and_tokens(monkeypatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/v1/runs"
        return httpx.Response(
            200,
            json={
                "data": {
                    "runs": [
                        {
                            "id": "r_1",
                            "status": "succeeded",
                            "errorCode": None,
                            "createdAt": "2026-08-13T00:00:00Z",
                            "costUsdMicros": 12345,
                            "tokensIn": 100,
                            "tokensOut": 50,
                        }
                    ]
                }
            },
        )

    _install_signed_in(monkeypatch)
    _install_client(monkeypatch, handler)

    result = runner.invoke(worker_cli.cli, ["runs"], catch_exceptions=False)

    assert result.exit_code == 0, result.output
    assert "r_1" in result.output
    assert "$0.0123" in result.output
    assert "100" in result.output
    assert "50" in result.output


def test_runs_json_flag_emits_raw_rows(monkeypatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "data": {
                    "runs": [
                        {
                            "id": "r_1",
                            "status": "succeeded",
                            "errorCode": None,
                            "createdAt": "2026-08-13T00:00:00Z",
                            "costUsdMicros": 0,
                            "tokensIn": 0,
                            "tokensOut": 0,
                        }
                    ]
                }
            },
        )

    _install_signed_in(monkeypatch)
    _install_client(monkeypatch, handler)

    result = runner.invoke(worker_cli.cli, ["runs", "--json"], catch_exceptions=False)

    assert result.exit_code == 0, result.output
    rows = json.loads(result.output)
    assert rows == [
        {
            "id": "r_1",
            "status": "succeeded",
            "errorCode": None,
            "createdAt": "2026-08-13T00:00:00Z",
            "costUsdMicros": 0,
            "tokensIn": 0,
            "tokensOut": 0,
        }
    ]


# -- logs -------------------------------------------------------------------


def test_logs_prints_trace_url(monkeypatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/v1/runs/r_1/trace"
        return httpx.Response(307, headers={"location": "https://s3.example.test/t.json"})

    _install_signed_in(monkeypatch)
    _install_client(monkeypatch, handler)

    result = runner.invoke(worker_cli.cli, ["logs", "r_1"], catch_exceptions=False)

    assert result.exit_code == 0, result.output
    assert result.output.strip() == "https://s3.example.test/t.json"


def test_logs_trace_unavailable_exits_1(monkeypatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            404,
            json={
                "error": {
                    "code": "trace_unavailable",
                    "message": "This run has no uploaded trace",
                    "requestId": "r",
                    "retryable": False,
                }
            },
        )

    _install_signed_in(monkeypatch)
    _install_client(monkeypatch, handler)

    result = runner.invoke(worker_cli.cli, ["logs", "r_1"], catch_exceptions=False)

    assert result.exit_code == 1, result.output
    assert "no uploaded trace" in result.output.lower()


# -- pause / resume -----------------------------------------------------


def test_pause_maps_to_patch_paused(monkeypatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "PATCH"
        assert request.url.path == "/api/v1/agents/t/deployments"
        assert json.loads(request.content) == {"env": "dev", "status": "paused"}
        return httpx.Response(
            200, json={"data": {"agentId": "ag_1", "env": "dev", "status": "paused"}}
        )

    _install_signed_in(monkeypatch)
    _install_client(monkeypatch, handler)

    result = runner.invoke(worker_cli.cli, ["pause", "t"], catch_exceptions=False)
    assert result.exit_code == 0, result.output


def test_resume_maps_to_patch_active(monkeypatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert json.loads(request.content) == {"env": "prod", "status": "active"}
        return httpx.Response(
            200, json={"data": {"agentId": "ag_1", "env": "prod", "status": "active"}}
        )

    _install_signed_in(monkeypatch)
    _install_client(monkeypatch, handler)

    result = runner.invoke(worker_cli.cli, ["resume", "t", "--env", "prod"], catch_exceptions=False)
    assert result.exit_code == 0, result.output


def test_pause_not_deployed_exits_1_with_server_message(monkeypatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            404,
            json={
                "error": {
                    "code": "not_deployed",
                    "message": "no active deployment for env",
                    "requestId": "r",
                    "retryable": False,
                }
            },
        )

    _install_signed_in(monkeypatch)
    _install_client(monkeypatch, handler)

    result = runner.invoke(worker_cli.cli, ["pause", "t"], catch_exceptions=False)
    assert result.exit_code == 1, result.output
    assert "no active deployment" in result.output.lower()
