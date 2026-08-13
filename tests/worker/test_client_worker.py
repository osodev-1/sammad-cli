"""SanadClient worker-agent methods: deploy/runs/logs/pause/resume (Task 9).

Envelope shapes here follow the actual routes (not the earlier plan sketch):
POST /api/v1/agents returns ``{data: {agentId, name, workspace}}`` (agentId,
not id); GET /api/v1/runs returns ``{data: {runs: [...]}}`` (nested, not a
bare list) — see control-plane/artifacts/sanad-web/app/api/v1/agents/route.ts
and .../runs/route.ts.
"""

from __future__ import annotations

import httpx

from kimi_cli.sanad.client import SanadClient
from kimi_cli.sanad.errors import SanadError
from kimi_cli.sanad.settings import SanadSettings


def _client(handler) -> SanadClient:
    settings = SanadSettings(api_base_url="https://cp.test")
    return SanadClient(settings, transport=httpx.MockTransport(handler))


def test_deploy_agent_three_calls_in_order() -> None:
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(f"{request.method} {request.url.path}")
        if request.url.path == "/api/v1/agents":
            return httpx.Response(200, json={"data": {"agentId": "ag_1", "name": "t"}})
        if request.url.path == "/api/v1/agents/t/versions":
            return httpx.Response(
                200, json={"data": {"versionId": "av_1", "contentHash": "aa" * 32}}
            )
        return httpx.Response(200, json={"data": {"deploymentId": "dp_1"}})

    out = _client(handler).deploy_agent("sess", name="t", files={"agent.yaml": "x"}, env="dev")
    assert calls == [
        "POST /api/v1/agents",
        "POST /api/v1/agents/t/versions",
        "POST /api/v1/agents/t/deployments",
    ]
    assert out.agent_id == "ag_1"
    assert out.version_id == "av_1"
    assert out.deployment_id == "dp_1"
    assert out.content_hash == "aa" * 32


def test_deploy_agent_sends_files_and_env_downstream() -> None:
    seen: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        import json as _json

        if request.url.path == "/api/v1/agents":
            body = _json.loads(request.content)
            seen["create"] = body
            return httpx.Response(200, json={"data": {"agentId": "ag_1", "name": "t"}})
        if request.url.path == "/api/v1/agents/t/versions":
            seen["files"] = _json.loads(request.content)["files"]
            return httpx.Response(
                200, json={"data": {"versionId": "av_1", "contentHash": "bb" * 32}}
            )
        seen["deploy"] = _json.loads(request.content)
        return httpx.Response(200, json={"data": {"deploymentId": "dp_1"}})

    _client(handler).deploy_agent(
        "sess", name="t", files={"agent.yaml": "x", "worker.yaml": "y"}, env="dev", workspace="ws1"
    )
    assert seen["create"] == {"name": "t", "workspace": "ws1"}
    assert seen["files"] == {"agent.yaml": "x", "worker.yaml": "y"}
    assert seen["deploy"] == {"versionId": "av_1", "env": "dev"}


def test_list_runs_unwraps_nested_envelope() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.params["agent"] == "t"
        assert "env" not in request.url.params
        return httpx.Response(
            200,
            json={
                "data": {
                    "runs": [
                        {
                            "id": "r_abcabcabcabc",
                            "status": "succeeded",
                            "errorCode": None,
                            "createdAt": "2026-08-13T00:00:00Z",
                            "costUsdMicros": 12,
                            "tokensIn": 5,
                            "tokensOut": 7,
                        }
                    ]
                }
            },
        )

    rows = _client(handler).list_runs("sess", agent="t", env=None)
    assert rows[0].id == "r_abcabcabcabc"
    assert rows[0].status == "succeeded"
    assert rows[0].error_code is None
    assert rows[0].cost_usd_micros == 12
    assert rows[0].tokens_in == 5
    assert rows[0].tokens_out == 7


def test_get_run_unwraps_nested_envelope() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/v1/runs/r_1"
        return httpx.Response(
            200,
            json={
                "data": {
                    "run": {
                        "id": "r_1",
                        "status": "failed",
                        "errorCode": "provider_error",
                        "createdAt": "2026-08-13T00:00:00Z",
                        "costUsdMicros": 0,
                        "tokensIn": 1,
                        "tokensOut": 0,
                    }
                }
            },
        )

    row = _client(handler).get_run("sess", "r_1")
    assert row.id == "r_1"
    assert row.status == "failed"
    assert row.error_code == "provider_error"


def test_get_run_trace_url_reads_redirect_location() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/v1/runs/r_1/trace"
        return httpx.Response(307, headers={"location": "https://s3.example.test/trace.json"})

    url = _client(handler).get_run_trace_url("sess", "r_1")
    assert url == "https://s3.example.test/trace.json"


def test_get_run_trace_url_raises_on_trace_unavailable() -> None:
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

    try:
        _client(handler).get_run_trace_url("sess", "r_1")
        raise AssertionError("expected SanadError")
    except SanadError as exc:
        assert exc.code == "trace_unavailable"
        assert exc.status == 404


def test_set_deployment_status_patches_env_and_status() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "PATCH"
        assert request.url.path == "/api/v1/agents/t/deployments"
        return httpx.Response(
            200, json={"data": {"agentId": "ag_1", "env": "dev", "status": "paused"}}
        )

    _client(handler).set_deployment_status("sess", agent="t", env="dev", status="paused")


def test_set_deployment_status_raises_not_deployed() -> None:
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

    try:
        _client(handler).set_deployment_status("sess", agent="t", env="dev", status="paused")
        raise AssertionError("expected SanadError")
    except SanadError as exc:
        assert exc.code == "not_deployed"
