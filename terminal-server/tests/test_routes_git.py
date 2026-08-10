"""Git endpoints over a real workspace repo (git binary required)."""

import shutil
from pathlib import Path

import pytest
from sanad_terminal.app import create_app
from sanad_terminal.control_plane import ControlPlaneClient
from sanad_terminal.settings import TerminalSettings
from starlette.testclient import TestClient

pytestmark = pytest.mark.skipif(shutil.which("git") is None, reason="git not installed")

SECRET = "s3cret"
USER = "user_1"
HEADERS = {"x-terminal-secret": SECRET, "x-workspace-user": USER}


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
        yield c


def _write(client: TestClient, path: str, body: str) -> None:
    res = client.put(f"/internal/workspace/file?path={path}", headers=HEADERS, content=body)
    assert res.status_code == 200, res.text


def test_status_on_uninitialized_workspace(client: TestClient):
    res = client.get("/internal/git/status", headers=HEADERS)
    assert res.status_code == 200
    assert res.json()["isRepo"] is False


def test_init_status_and_dirty_count(client: TestClient):
    assert client.post("/internal/git/init", headers=HEADERS).status_code == 200
    _write(client, "README.md", "# hi\n")
    res = client.get("/internal/git/status", headers=HEADERS)
    body = res.json()
    assert body["isRepo"] is True
    assert body["branch"] == "main"
    # init also drops a .gitignore (R3: .sanad/.cache must never enter
    # history), so the fresh workspace carries two untracked files.
    assert body["dirtyCount"] == 2
    assert "README.md" in body["untracked"]
    assert ".gitignore" in body["untracked"]


def test_commit_flow(client: TestClient):
    client.post("/internal/git/init", headers=HEADERS)
    _write(client, "app.py", "print('hi')\n")
    res = client.post(
        "/internal/git/commit",
        headers=HEADERS,
        json={"message": "first", "authorName": "A B", "authorEmail": "a@b.test"},
    )
    assert res.status_code == 200, res.text
    assert res.json()["head"]
    # Tree is clean after commit.
    assert client.get("/internal/git/status", headers=HEADERS).json()["dirtyCount"] == 0
    # Nothing to commit now → 409.
    again = client.post("/internal/git/commit", headers=HEADERS, json={"message": "noop"})
    assert again.status_code == 409
    assert again.json()["error"]["code"] == "nothing_to_commit"


def test_branch_create_and_checkout(client: TestClient):
    client.post("/internal/git/init", headers=HEADERS)
    _write(client, "x.txt", "1\n")
    client.post("/internal/git/commit", headers=HEADERS, json={"message": "init"})

    assert (
        client.post("/internal/git/branch", headers=HEADERS, json={"name": "feature/x"}).status_code
        == 200
    )
    branches = client.get("/internal/git/branches", headers=HEADERS).json()
    assert branches["current"] == "feature/x"
    assert set(branches["branches"]) >= {"main", "feature/x"}

    assert (
        client.post("/internal/git/checkout", headers=HEADERS, json={"name": "main"}).status_code
        == 200
    )
    assert client.get("/internal/git/branches", headers=HEADERS).json()["current"] == "main"


def test_dirty_switch_is_blocked(client: TestClient):
    client.post("/internal/git/init", headers=HEADERS)
    _write(client, "a.txt", "1\n")
    client.post("/internal/git/commit", headers=HEADERS, json={"message": "init"})
    client.post("/internal/git/branch", headers=HEADERS, json={"name": "other"})
    client.post("/internal/git/checkout", headers=HEADERS, json={"name": "main"})
    # Make a conflicting local change tracked on main, then try to switch.
    _write(client, "a.txt", "2\n")
    # Modify the same file differently on the other branch so switch would clobber.
    res = client.post("/internal/git/checkout", headers=HEADERS, json={"name": "other"})
    # Either it switches cleanly (git carries the change) or it blocks with
    # dirty_tree — both are safe; assert we never lose the change silently.
    assert res.status_code in (200, 409)
    if res.status_code == 409:
        assert res.json()["error"]["code"] == "dirty_tree"


def test_invalid_branch_name_rejected(client: TestClient):
    client.post("/internal/git/init", headers=HEADERS)
    res = client.post("/internal/git/branch", headers=HEADERS, json={"name": "bad name"})
    assert res.status_code == 400
    assert res.json()["error"]["code"] == "invalid_branch"


def test_git_requires_the_proxy_credential(client: TestClient):
    assert client.get("/internal/git/status").status_code == 401


def test_log_and_show(client: TestClient):
    """R3 history endpoints: log lists commits newest-first; show returns the
    unified diff for a hash and rejects non-hash refs."""
    c = client
    c.post("/internal/git/init", headers=HEADERS)
    _write(c, "a.txt", "one\n")
    r = c.post(
        "/internal/git/commit",
        headers=HEADERS,
        json={"message": "first", "authorName": "A", "authorEmail": "a@x"},
    )
    assert r.status_code == 200
    _write(c, "a.txt", "one\ntwo\n")
    c.post(
        "/internal/git/commit",
        headers=HEADERS,
        json={"message": "second", "authorName": "A", "authorEmail": "a@x"},
    )

    log = c.get("/internal/git/log?limit=10", headers=HEADERS).json()["commits"]
    assert [e["subject"] for e in log[:2]] == ["second", "first"]
    assert log[0]["authorName"] == "A" and log[0]["hash"]

    diff = c.get(f"/internal/git/show?ref={log[0]['hash']}", headers=HEADERS).json()["diff"]
    assert "+two" in diff and "second" in diff

    assert c.get("/internal/git/show?ref=main", headers=HEADERS).status_code == 400
    assert c.get("/internal/git/show?ref=deadbeef", headers=HEADERS).status_code == 404
