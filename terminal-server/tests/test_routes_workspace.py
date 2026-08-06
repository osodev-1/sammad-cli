import io
import zipfile
from pathlib import Path

import pytest
from sanad_terminal.app import create_app
from sanad_terminal.control_plane import ControlPlaneClient
from sanad_terminal.settings import TerminalSettings
from starlette.testclient import TestClient

SECRET = "s3cret"
USER = "user_1"
HEADERS = {"x-terminal-secret": SECRET, "x-workspace-user": USER}


@pytest.fixture
def client(tmp_path: Path):
    settings = TerminalSettings(
        shared_secret=SECRET,
        users_dir=tmp_path / "users",
        spawn_argv=("/bin/true",),
        max_upload_bytes=1024,
    )
    cp = ControlPlaneClient("https://cp.test", SECRET)
    app = create_app(settings, cp)
    with TestClient(app) as c:
        yield c


def test_secret_and_user_required(client: TestClient):
    assert client.get("/internal/workspace/tree").status_code == 401
    assert (
        client.get(
            "/internal/workspace/tree",
            headers={"x-terminal-secret": "wrong", "x-workspace-user": USER},
        ).status_code
        == 401
    )
    res = client.get("/internal/workspace/tree", headers={"x-terminal-secret": SECRET})
    assert res.status_code == 400
    res = client.get(
        "/internal/workspace/tree",
        headers={"x-terminal-secret": SECRET, "x-workspace-user": "../evil"},
    )
    assert res.status_code == 400


def test_crud_flow(client: TestClient):
    # empty workspace
    res = client.get("/internal/workspace/tree", headers=HEADERS)
    assert res.status_code == 200
    assert res.json() == {"entries": []}

    # write a file (creates parents)
    res = client.put(
        "/internal/workspace/file",
        params={"path": "docs/readme.md"},
        headers=HEADERS,
        content=b"# hi",
    )
    assert res.status_code == 200
    assert res.json()["entry"]["path"] == "docs/readme.md"

    # read it back
    res = client.get("/internal/workspace/file", params={"path": "docs/readme.md"}, headers=HEADERS)
    assert res.status_code == 200
    assert res.content == b"# hi"
    assert res.headers["x-file-name"] == "readme.md"

    # mkdir + move + search + snapshot
    assert (
        client.post(
            "/internal/workspace/mkdir", json={"path": "assets"}, headers=HEADERS
        ).status_code
        == 200
    )
    res = client.patch(
        "/internal/workspace/move",
        json={"from": "docs/readme.md", "to": "assets/readme.md"},
        headers=HEADERS,
    )
    assert res.status_code == 200
    res = client.get("/internal/workspace/search", params={"q": "readme"}, headers=HEADERS)
    assert [e["path"] for e in res.json()["entries"]] == ["assets/readme.md"]
    res = client.get("/internal/workspace/snapshot", headers=HEADERS)
    assert {"assets", "assets/readme.md", "docs"} <= {e["path"] for e in res.json()["entries"]}

    # delete
    assert (
        client.delete(
            "/internal/workspace/file", params={"path": "assets"}, headers=HEADERS
        ).status_code
        == 200
    )
    res = client.get("/internal/workspace/search", params={"q": "readme"}, headers=HEADERS)
    assert res.json()["entries"] == []


def test_upload_multiple_and_zip_download(client: TestClient):
    res = client.post(
        "/internal/workspace/upload",
        params={"dir": "in"},
        headers=HEADERS,
        files=[
            ("files", ("a.txt", b"aaa", "text/plain")),
            ("files", ("../../evil.sh", b"#!/bin/sh", "text/x-sh")),
        ],
    )
    assert res.status_code == 200
    assert [e["path"] for e in res.json()["entries"]] == ["in/a.txt", "in/evil.sh"]

    res = client.post("/internal/workspace/archive", json={"path": "in"}, headers=HEADERS)
    assert res.status_code == 200
    assert res.headers["content-type"] == "application/zip"
    with zipfile.ZipFile(io.BytesIO(res.content)) as zf:
        assert sorted(zf.namelist()) == ["in/a.txt", "in/evil.sh"]


def test_upload_size_cap(client: TestClient):
    res = client.post(
        "/internal/workspace/upload",
        headers=HEADERS,
        files=[("files", ("big.bin", b"x" * 2048, "application/octet-stream"))],
    )
    assert res.status_code == 413
    assert res.json()["error"]["code"] == "too_large"


def test_error_mapping(client: TestClient):
    res = client.get("/internal/workspace/file", params={"path": "nope.txt"}, headers=HEADERS)
    assert res.status_code == 404
    assert res.json()["error"]["code"] == "not_found"

    res = client.get("/internal/workspace/tree", params={"path": "../.."}, headers=HEADERS)
    assert res.status_code == 400
    assert res.json()["error"]["code"] == "invalid_path"

    res = client.delete("/internal/workspace/file", params={"path": ""}, headers=HEADERS)
    assert res.status_code == 400
