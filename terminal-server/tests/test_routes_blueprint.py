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
        res = client.put(f"/internal/workspace/file?path={path}", headers=HEADERS, content=body)
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
    assert (
        client.get("/internal/blueprint/resource?id=agent:nope", headers=HEADERS).status_code == 404
    )


def test_schemas_cover_every_kind(client: TestClient):
    res = client.get("/internal/blueprint/schemas", headers=HEADERS)
    assert res.status_code == 200
    schemas = res.json()["schemas"]
    assert "Agent" in schemas and "PublishProfile" in schemas


def test_templates_lists_creatable_kinds(client: TestClient):
    res = client.get("/internal/blueprint/templates", headers=HEADERS)
    assert res.status_code == 200
    kinds = {k["kind"] for k in res.json()["kinds"]}
    assert {"Agent", "Skill", "Tool"} <= kinds


def test_plan_and_apply_create_resource(client: TestClient):
    _seed(client)
    # Plan a new Tool — nothing is written yet.
    plan_res = client.post(
        "/internal/blueprint/plan",
        headers=HEADERS,
        json={"action": "createResource", "kind": "Tool", "name": "Workspace Files"},
    )
    assert plan_res.status_code == 200
    plan = plan_res.json()["plan"]
    assert plan["graphDelta"]["nodesAdded"] == ["tool:workspace-files"]
    # Graph still lacks it (plan didn't write).
    before = client.get("/internal/blueprint/graph", headers=HEADERS).json()
    assert not any(n["id"] == "tool:workspace-files" for n in before["nodes"])

    # Apply → written + indexed, returns the fresh graph + a txId.
    apply_res = client.post("/internal/blueprint/apply", headers=HEADERS, json={"plan": plan})
    assert apply_res.status_code == 200, apply_res.text
    body = apply_res.json()
    assert body["txId"].startswith("tx_")
    assert any(n["id"] == "tool:workspace-files" for n in body["graph"]["nodes"])


def test_apply_edge_then_rollback(client: TestClient):
    _seed(client)  # agent:primary (already uses skill:code-review) + skill:code-review
    # Scaffold a fresh skill the agent does NOT yet use, then connect it.
    extra = client.post(
        "/internal/blueprint/plan",
        headers=HEADERS,
        json={"action": "createResource", "kind": "Skill", "name": "Extra"},
    ).json()["plan"]
    client.post("/internal/blueprint/apply", headers=HEADERS, json={"plan": extra})
    plan = client.post(
        "/internal/blueprint/plan",
        headers=HEADERS,
        json={
            "action": "createEdge",
            "source": "agent:primary",
            "edgeType": "uses",
            "target": "skill:extra",
        },
    ).json()["plan"]
    applied = client.post("/internal/blueprint/apply", headers=HEADERS, json={"plan": plan})
    assert applied.status_code == 200
    tx_id = applied.json()["txId"]
    edges = applied.json()["graph"]["edges"]
    assert any(
        e["source"] == "agent:primary" and e["type"] == "uses" and e["target"] == "skill:extra"
        for e in edges
    )

    rb = client.post("/internal/blueprint/rollback", headers=HEADERS, json={"txId": tx_id})
    assert rb.status_code == 200
    edges2 = rb.json()["graph"]["edges"]
    assert not any(e["source"] == "agent:primary" and e["target"] == "skill:extra" for e in edges2)


def test_stale_apply_is_rejected(client: TestClient):
    _seed(client)
    tool = client.post(
        "/internal/blueprint/plan",
        headers=HEADERS,
        json={"action": "createResource", "kind": "Tool", "name": "T"},
    ).json()["plan"]
    client.post("/internal/blueprint/apply", headers=HEADERS, json={"plan": tool})
    plan = client.post(
        "/internal/blueprint/plan",
        headers=HEADERS,
        json={
            "action": "createEdge",
            "source": "agent:primary",
            "edgeType": "invokes",
            "target": "tool:t",
        },
    ).json()["plan"]
    # Change the source manifest after planning.
    client.put(
        "/internal/workspace/file?path=.sanad/agents/primary/agent.yaml",
        headers=HEADERS,
        content=AGENT + "\n# edited\n",
    )
    res = client.post("/internal/blueprint/apply", headers=HEADERS, json={"plan": plan})
    assert res.status_code == 409
    assert res.json()["error"]["code"] == "stale_plan"


def test_apply_requires_credential(client: TestClient):
    assert client.post("/internal/blueprint/apply", json={"plan": {}}).status_code == 401


# ---- S9 trust: apply-auto-trust, manual review, graph annotation ----


def test_apply_records_trust_for_skill_instructions(client: TestClient):
    """Apply IS the review: a skill written via apply is trusted at once."""
    _seed(client)
    plan = client.post(
        "/internal/blueprint/plan",
        headers=HEADERS,
        json={"action": "createResource", "kind": "Skill", "name": "Review Helper"},
    ).json()["plan"]
    body = client.post("/internal/blueprint/apply", headers=HEADERS, json={"plan": plan}).json()

    entries = client.get("/internal/blueprint/trust", headers=HEADERS).json()["entries"]
    entry = entries[".sanad/skills/review-helper/SKILL.md"]
    assert entry["status"] == "trusted"
    assert entry["source"] == "apply"

    node = next(n for n in body["graph"]["nodes"] if n["id"] == "skill:review-helper")
    assert node["trust"] == "trusted"


def test_external_skill_untrusted_until_reviewed_then_changed(client: TestClient):
    """Content arriving OUTSIDE apply needs the one-time review; edits re-gate."""
    _seed(client)  # seeds skill:code-review with a manifest but no SKILL.md
    rel = ".sanad/skills/code-review/SKILL.md"
    res = client.put(
        f"/internal/workspace/file?path={rel}",
        headers=HEADERS,
        content=b"---\nname: code-review\n---\nReview the diff.\n",
    )
    assert res.status_code == 200

    entries = client.get("/internal/blueprint/trust", headers=HEADERS).json()["entries"]
    assert entries[rel]["status"] == "untrusted"
    graph = client.get("/internal/blueprint/graph", headers=HEADERS).json()
    node = next(n for n in graph["nodes"] if n["id"] == "skill:code-review")
    assert node["trust"] == "untrusted"

    reviewed = client.post("/internal/blueprint/trust", headers=HEADERS, json={"path": rel})
    assert reviewed.status_code == 200
    assert reviewed.json()["entries"][rel]["status"] == "trusted"
    assert reviewed.json()["entries"][rel]["source"] == "manual"

    # An edit after review reverts the state to "changed" (re-review required).
    client.put(
        f"/internal/workspace/file?path={rel}",
        headers=HEADERS,
        content=b"---\nname: code-review\n---\nEDITED.\n",
    )
    entries = client.get("/internal/blueprint/trust", headers=HEADERS).json()["entries"]
    assert entries[rel]["status"] == "changed"
    graph = client.get("/internal/blueprint/graph", headers=HEADERS).json()
    node = next(n for n in graph["nodes"] if n["id"] == "skill:code-review")
    assert node["trust"] == "changed"


def test_trust_review_rejects_bad_paths_and_requires_auth(client: TestClient):
    _seed(client)
    assert (
        client.post(
            "/internal/blueprint/trust",
            headers=HEADERS,
            json={"path": ".sanad/skills/code-review/skill.yaml"},  # declarative
        ).status_code
        == 400
    )
    assert (
        client.post(
            "/internal/blueprint/trust",
            headers=HEADERS,
            json={"path": ".sanad/skills/ghost/SKILL.md"},  # no such file
        ).status_code
        == 404
    )
    assert client.get("/internal/blueprint/trust").status_code == 401
