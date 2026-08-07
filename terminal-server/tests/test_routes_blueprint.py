"""Blueprint endpoints: auth reuse + graph/validate/schemas over a real .sanad."""

from pathlib import Path

import pytest
from sanad_terminal.app import create_app
from sanad_terminal.control_plane import ControlPlaneClient
from sanad_terminal.settings import TerminalSettings
from starlette.testclient import TestClient

SECRET = "s3cret"
USER = "user_1"
HEADERS = {"x-terminal-secret": SECRET, "x-workspace-user": USER}

AGENT = """\
apiVersion: sanad.dev/v1alpha1
kind: Agent
metadata:
  id: agent:primary
  name: Primary
spec:
  skills:
    - skill:code-review
"""
SKILL = """\
apiVersion: sanad.dev/v1alpha1
kind: Skill
metadata:
  id: skill:code-review
  name: Code Review
spec: {}
"""


@pytest.fixture
def client(tmp_path: Path):
    settings = TerminalSettings(
        shared_secret=SECRET,
        users_dir=tmp_path / "users",
        spawn_argv=("/bin/true",),
    )
    cp = ControlPlaneClient("https://cp.test", SECRET)
    app = create_app(settings, cp)
    with TestClient(app) as c:
        c._users_dir = tmp_path / "users"  # type: ignore[attr-defined]
        yield c


def _seed(client: TestClient) -> None:
    """Write a two-resource blueprint through the workspace file API."""
    for path, body in (
        (".sanad/agents/primary/agent.yaml", AGENT),
        (".sanad/skills/code-review/skill.yaml", SKILL),
    ):
        res = client.put(
            f"/internal/workspace/file?path={path}", headers=HEADERS, content=body
        )
        assert res.status_code == 200, res.text


def test_blueprint_requires_the_proxy_credential(client: TestClient):
    assert client.get("/internal/blueprint/graph").status_code == 401
    assert (
        client.get(
            "/internal/blueprint/graph",
            headers={"x-terminal-secret": "wrong", "x-workspace-user": USER},
        ).status_code
        == 401
    )


def test_graph_empty_before_init(client: TestClient):
    res = client.get("/internal/blueprint/graph", headers=HEADERS)
    assert res.status_code == 200
    body = res.json()
    assert body["initialized"] is False
    assert body["nodes"] == []


def test_graph_reflects_written_manifests(client: TestClient):
    _seed(client)
    res = client.get("/internal/blueprint/graph", headers=HEADERS)
    assert res.status_code == 200
    body = res.json()
    assert body["initialized"] is True
    ids = {n["id"] for n in body["nodes"]}
    assert {"agent:primary", "skill:code-review"} <= ids
    edges = {(e["source"], e["type"], e["target"]) for e in body["edges"]}
    assert ("agent:primary", "uses", "skill:code-review") in edges
    assert not any(e["broken"] for e in body["edges"])


def test_validate_flags_a_broken_reference(client: TestClient):
    client.put(
        "/internal/workspace/file?path=.sanad/agents/p/agent.yaml",
        headers=HEADERS,
        content=(
            "apiVersion: sanad.dev/v1alpha1\nkind: Agent\n"
            "metadata:\n  id: agent:p\n  name: P\n"
            "spec:\n  skills:\n    - skill:missing\n"
        ),
    )
    res = client.post("/internal/blueprint/validate", headers=HEADERS)
    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is False
    assert any(d["code"] == "unresolved_reference" for d in body["diagnostics"])


def test_resource_endpoint(client: TestClient):
    _seed(client)
    res = client.get("/internal/blueprint/resource?id=agent:primary", headers=HEADERS)
    assert res.status_code == 200
    body = res.json()
    assert body["kind"] == "Agent"
    assert body["manifestPath"].endswith("agent.yaml")
    assert client.get(
        "/internal/blueprint/resource?id=agent:nope", headers=HEADERS
    ).status_code == 404


def test_schemas_cover_every_kind(client: TestClient):
    res = client.get("/internal/blueprint/schemas", headers=HEADERS)
    assert res.status_code == 200
    schemas = res.json()["schemas"]
    assert "Agent" in schemas and "PublishProfile" in schemas
