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


def test_plan_delete_resource_and_trust_cleanup(client: TestClient):
    """deleteResource plans the removal + reference cascade; applying it also
    drops the skill's trust entry so an orphaned record can never vouch for
    content recreated later at the same path."""
    _seed(client)  # the seed agent already `uses` the skill — cascade fodder
    res = client.put(
        "/internal/workspace/file?path=.sanad/skills/code-review/SKILL.md",
        headers=HEADERS,
        content=b"# Review\n",
    )
    assert res.status_code == 200
    reviewed = client.post(
        "/internal/blueprint/trust",
        headers=HEADERS,
        json={"path": ".sanad/skills/code-review/SKILL.md"},
    )
    assert reviewed.status_code == 200

    plan_res = client.post(
        "/internal/blueprint/plan",
        headers=HEADERS,
        json={"action": "deleteResource", "id": "skill:code-review"},
    )
    assert plan_res.status_code == 200, plan_res.text
    plan = plan_res.json()["plan"]
    assert plan["graphDelta"]["nodesRemoved"] == ["skill:code-review"]

    apply_res = client.post("/internal/blueprint/apply", headers=HEADERS, json={"plan": plan})
    assert apply_res.status_code == 200, apply_res.text
    graph = apply_res.json()["graph"]
    assert not any(n["id"] == "skill:code-review" for n in graph["nodes"])
    # Trust entry is gone with the definition.
    trust = client.get("/internal/blueprint/trust", headers=HEADERS).json()
    assert ".sanad/skills/code-review/SKILL.md" not in trust.get("entries", trust)


def test_plan_remove_edge_action(client: TestClient):
    _seed(client)  # the seed already contains agent:primary uses skill:code-review
    remove = client.post(
        "/internal/blueprint/plan",
        headers=HEADERS,
        json={"action": "removeEdge", "source": "agent:primary", "target": "skill:code-review"},
    )
    assert remove.status_code == 200, remove.text
    plan = remove.json()["plan"]
    assert plan["graphDelta"]["edgesRemoved"] == [
        {"from": "agent:primary", "type": "uses", "to": "skill:code-review"}
    ]
    applied = client.post("/internal/blueprint/apply", headers=HEADERS, json={"plan": plan})
    assert applied.status_code == 200
    assert not any(
        e["source"] == "agent:primary" and e["target"] == "skill:code-review"
        for e in applied.json()["graph"]["edges"]
    )


def test_graph_annotates_committedness(client: TestClient):
    """Nodes carry git state — untracked (never committed) vs modified
    (tracked, dirty) vs clean (no key) — and the graph degrades to no
    annotation when the workspace has no repo at all."""
    import subprocess

    _seed(client)
    # No repo yet → no git keys anywhere.
    bare = client.get("/internal/blueprint/graph", headers=HEADERS).json()
    assert all("git" not in n for n in bare["nodes"])

    ws = client._users_dir / USER / "workspace"  # type: ignore[attr-defined]
    env = {
        "GIT_AUTHOR_NAME": "t",
        "GIT_AUTHOR_EMAIL": "t@t",
        "GIT_COMMITTER_NAME": "t",
        "GIT_COMMITTER_EMAIL": "t@t",
        "HOME": str(ws),
        "PATH": "/usr/bin:/bin:/usr/local/bin",
    }
    subprocess.run(["git", "init", "-q", "-b", "main"], cwd=ws, env=env, check=True)
    # Commit the agent; leave the skill folder untracked.
    subprocess.run(["git", "add", ".sanad/agents"], cwd=ws, env=env, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "seed"], cwd=ws, env=env, check=True)

    g = client.get("/internal/blueprint/graph", headers=HEADERS).json()
    by_id = {n["id"]: n for n in g["nodes"]}
    assert "git" not in by_id["agent:primary"]  # committed = clean
    assert by_id["skill:code-review"]["git"] == "untracked"

    # Edit the committed agent manifest → modified.
    (ws / ".sanad/agents/primary/agent.yaml").write_text(
        (ws / ".sanad/agents/primary/agent.yaml").read_text() + "# touched\n"
    )
    g2 = client.get("/internal/blueprint/graph", headers=HEADERS).json()
    assert {n["id"]: n.get("git") for n in g2["nodes"]}["agent:primary"] == "modified"


def _init_repo(client: TestClient):
    import subprocess

    ws = client._users_dir / USER / "workspace"  # type: ignore[attr-defined]
    env = {
        "GIT_AUTHOR_NAME": "t",
        "GIT_AUTHOR_EMAIL": "t@t",
        "GIT_COMMITTER_NAME": "t",
        "GIT_COMMITTER_EMAIL": "t@t",
        "HOME": str(ws),
        "PATH": "/usr/bin:/bin:/usr/local/bin",
    }
    subprocess.run(["git", "init", "-q", "-b", "main"], cwd=ws, env=env, check=True)
    subprocess.run(["git", "add", "-A"], cwd=ws, env=env, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "seed"], cwd=ws, env=env, check=True)
    return ws, env


def test_apply_auto_commits_scoped_to_sanad(client: TestClient):
    """R3: a governed apply lands in git with the proxy-injected identity —
    scoped to .sanad, so the user's unrelated edits stay out of the commit."""
    import subprocess

    _seed(client)
    ws, env = _init_repo(client)
    # An unrelated dirty file that must NOT be swept into the blueprint commit.
    (ws / "notes.txt").write_text("wip\n")

    plan = client.post(
        "/internal/blueprint/plan",
        headers=HEADERS,
        json={"action": "createResource", "kind": "Tool", "name": "T"},
    ).json()["plan"]
    res = client.post(
        "/internal/blueprint/apply",
        headers={**HEADERS, "x-author-name": "Omar A", "x-author-email": "omar@x.test"},
        json={"plan": plan},
    )
    assert res.status_code == 200
    assert res.json()["committed"] is True

    log = subprocess.run(
        ["git", "log", "-1", "--format=%an|%s", "--name-only"],
        cwd=ws,
        env=env,
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    assert log.startswith("Omar A|blueprint: Create Tool “T” [tx_")
    assert ".sanad/tools/t/tool.yaml" in log
    assert "notes.txt" not in log  # unrelated edit untouched
    # And the tx id in the subject matches the response.
    assert res.json()["txId"] in log


def test_rollback_is_safe_and_reverts_commit(client: TestClient):
    """R3: revert replays only while the tree matches the apply's recorded
    after-state; drift → 409 stale_rollback, nothing clobbered."""
    _seed(client)
    _init_repo(client)
    plan = client.post(
        "/internal/blueprint/plan",
        headers=HEADERS,
        json={"action": "createResource", "kind": "Tool", "name": "R"},
    ).json()["plan"]
    applied = client.post("/internal/blueprint/apply", headers=HEADERS, json={"plan": plan})
    tx_id = applied.json()["txId"]

    # Clean revert works and removes the resource.
    rb = client.post("/internal/blueprint/rollback", headers=HEADERS, json={"txId": tx_id})
    assert rb.status_code == 200
    assert not any(n["id"] == "tool:r" for n in rb.json()["graph"]["nodes"])

    # Re-apply, then drift the file — revert must refuse.
    plan2 = client.post(
        "/internal/blueprint/plan",
        headers=HEADERS,
        json={"action": "createResource", "kind": "Tool", "name": "R"},
    ).json()["plan"]
    applied2 = client.post("/internal/blueprint/apply", headers=HEADERS, json={"plan": plan2})
    tx2 = applied2.json()["txId"]
    client.put(
        "/internal/workspace/file?path=.sanad/tools/r/tool.yaml",
        headers=HEADERS,
        content=b"drifted: true\n",
    )
    stale = client.post("/internal/blueprint/rollback", headers=HEADERS, json={"txId": tx2})
    assert stale.status_code == 409
    assert stale.json()["error"]["code"] == "stale_rollback"
    # The drifted content survives untouched.
    kept = client.get("/internal/workspace/file?path=.sanad/tools/r/tool.yaml", headers=HEADERS)
    assert b"drifted" in kept.content
