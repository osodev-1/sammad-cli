"""R5 runtime activation: trusted blueprint MCP servers join the session.

The adapter is the MCP mirror of the skill trust gate: env-gated (local CLIs
untouched), content-addressed (raw-byte sha256 must be reviewed), fail-closed
(unreadable store or malformed manifest loads nothing).
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from kimi_cli.sanad.activation import workspace_mcp_configs

MCP_YAML = (
    "apiVersion: sanad.dev/v1alpha1\nkind: MCPServer\n"
    "metadata:\n  id: mcp:files\n  name: Files\n"
    "spec:\n  transport: stdio\n  command: node\n  args: [server.js]\n"
    "  env:\n    LOG: quiet\n"
)


def _workspace(tmp_path: Path, manifest: str = MCP_YAML) -> Path:
    d = tmp_path / "workspace" / ".sanad" / "mcps" / "files"
    d.mkdir(parents=True)
    (d / "mcp.yaml").write_text(manifest)
    return tmp_path / "workspace"


def _trust(tmp_path: Path, *contents: str) -> Path:
    store = tmp_path / "blueprint-trust.json"
    entries = {
        f"e{i}": {"sha256": hashlib.sha256(c.encode()).hexdigest()} for i, c in enumerate(contents)
    }
    store.write_text(json.dumps({"version": 1, "entries": entries}))
    return store


def test_no_env_means_no_op(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("SANAD_BLUEPRINT_TRUST", raising=False)
    ws = _workspace(tmp_path)
    assert workspace_mcp_configs(ws) == []


def test_trusted_manifest_becomes_fastmcp_config(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    ws = _workspace(tmp_path)
    monkeypatch.setenv("SANAD_BLUEPRINT_TRUST", str(_trust(tmp_path, MCP_YAML)))
    configs = workspace_mcp_configs(ws)
    assert configs == [
        {
            "mcpServers": {
                "files": {"command": "node", "args": ["server.js"], "env": {"LOG": "quiet"}}
            }
        }
    ]


def test_unreviewed_manifest_stays_inert(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    ws = _workspace(tmp_path)
    monkeypatch.setenv("SANAD_BLUEPRINT_TRUST", str(_trust(tmp_path, "something else")))
    assert workspace_mcp_configs(ws) == []


def test_corrupt_store_fails_closed(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    ws = _workspace(tmp_path)
    store = tmp_path / "blueprint-trust.json"
    store.write_text("{not json")
    monkeypatch.setenv("SANAD_BLUEPRINT_TRUST", str(store))
    assert workspace_mcp_configs(ws) == []


def test_inline_env_hash_set_loads_without_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """SANAD_BLUEPRINT_TRUST_SHA256S present → the inline hash set is trusted
    directly, no store file ever read."""
    monkeypatch.delenv("SANAD_BLUEPRINT_TRUST", raising=False)
    ws = _workspace(tmp_path)
    digest = hashlib.sha256(MCP_YAML.encode()).hexdigest()
    monkeypatch.setenv("SANAD_BLUEPRINT_TRUST_SHA256S", digest)
    configs = workspace_mcp_configs(ws)
    assert configs == [
        {
            "mcpServers": {
                "files": {"command": "node", "args": ["server.js"], "env": {"LOG": "quiet"}}
            }
        }
    ]


def test_inline_empty_env_wins_over_legacy_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Inline var present-even-empty takes precedence over a valid legacy
    file var — proves the CLI never falls back to the file once inline is set."""
    ws = _workspace(tmp_path)
    monkeypatch.setenv("SANAD_BLUEPRINT_TRUST", str(_trust(tmp_path, MCP_YAML)))
    monkeypatch.setenv("SANAD_BLUEPRINT_TRUST_SHA256S", "")
    assert workspace_mcp_configs(ws) == []


def test_http_transport_and_malformed_specs(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    http_yaml = (
        "apiVersion: sanad.dev/v1alpha1\nkind: MCPServer\n"
        "metadata:\n  id: mcp:remote\n  name: Remote\n"
        "spec:\n  transport: http\n  url: https://mcp.example/api\n"
    )
    bad_yaml = (
        "apiVersion: sanad.dev/v1alpha1\nkind: MCPServer\n"
        "metadata:\n  id: mcp:bad\n  name: Bad\n"
        "spec:\n  transport: stdio\n"  # no command → not runnable
    )
    ws = tmp_path / "workspace"
    for slug, content in (("remote", http_yaml), ("bad", bad_yaml)):
        d = ws / ".sanad" / "mcps" / slug
        d.mkdir(parents=True)
        (d / "mcp.yaml").write_text(content)
    monkeypatch.setenv("SANAD_BLUEPRINT_TRUST", str(_trust(tmp_path, http_yaml, bad_yaml)))
    configs = workspace_mcp_configs(ws)
    assert configs == [{"mcpServers": {"remote": {"url": "https://mcp.example/api"}}}]
