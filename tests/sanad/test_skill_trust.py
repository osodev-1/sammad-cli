"""S9 trust gate: `.sanad` skills load only when their content hash is reviewed.

The gate is env-driven (SANAD_BLUEPRINT_TRUST → the machine's trust store).
Local CLIs never set it, so discovery is unchanged there; governed workspace
machines set it via agentd's build_child_env.
"""

import hashlib
import json
from pathlib import Path

import pytest
from kaos.path import KaosPath

from kimi_cli.skill import discover_skills

TRUSTED_MD = "---\nname: reviewed\ndescription: Reviewed skill.\n---\nDo the thing.\n"
UNTRUSTED_MD = "---\nname: sneaky\ndescription: Never reviewed.\n---\nInjected steps.\n"


def _skills_root(tmp_path: Path) -> Path:
    root = tmp_path / "workspace" / ".sanad" / "skills"
    root.mkdir(parents=True)
    return root


def _write_skill(skills_root: Path, slug: str, body: str) -> Path:
    d = skills_root / slug
    d.mkdir()
    md = d / "SKILL.md"
    md.write_text(body, encoding="utf-8")
    return md


def _write_trust(tmp_path: Path, *files: Path) -> Path:
    store = tmp_path / "blueprint-trust.json"
    entries = {
        f"entry-{i}": {"sha256": hashlib.sha256(f.read_bytes()).hexdigest(), "source": "apply"}
        for i, f in enumerate(files)
    }
    store.write_text(json.dumps({"version": 1, "entries": entries}), encoding="utf-8")
    return store


async def _names(skills_dir: Path) -> list[str]:
    skills = await discover_skills(KaosPath.unsafe_from_local_path(skills_dir), scope="project")
    return [s.name for s in skills]


@pytest.mark.asyncio
async def test_gate_off_without_env_loads_everything(tmp_path: Path, monkeypatch):
    monkeypatch.delenv("SANAD_BLUEPRINT_TRUST", raising=False)
    root = _skills_root(tmp_path)
    _write_skill(root, "reviewed", TRUSTED_MD)
    _write_skill(root, "sneaky", UNTRUSTED_MD)
    assert await _names(root) == ["reviewed", "sneaky"]


@pytest.mark.asyncio
async def test_gate_filters_unreviewed_sanad_skills(tmp_path: Path, monkeypatch):
    root = _skills_root(tmp_path)
    trusted_md = _write_skill(root, "reviewed", TRUSTED_MD)
    _write_skill(root, "sneaky", UNTRUSTED_MD)
    store = _write_trust(tmp_path, trusted_md)
    monkeypatch.setenv("SANAD_BLUEPRINT_TRUST", str(store))
    assert await _names(root) == ["reviewed"]


@pytest.mark.asyncio
async def test_gate_ignores_non_sanad_roots(tmp_path: Path, monkeypatch):
    """A generic (non-.sanad) skills dir is never gated — plugins, builtins,
    ~/.agents all keep loading regardless of the trust store."""
    generic = tmp_path / "plain-skills"
    generic.mkdir()
    _write_skill(generic, "anything", UNTRUSTED_MD)
    store = _write_trust(tmp_path)  # empty store
    monkeypatch.setenv("SANAD_BLUEPRINT_TRUST", str(store))
    assert await _names(generic) == ["sneaky"]  # frontmatter name wins


@pytest.mark.asyncio
async def test_unreadable_store_fails_closed_for_sanad_roots(tmp_path: Path, monkeypatch):
    root = _skills_root(tmp_path)
    _write_skill(root, "reviewed", TRUSTED_MD)
    store = tmp_path / "blueprint-trust.json"
    store.write_text("{corrupt", encoding="utf-8")
    monkeypatch.setenv("SANAD_BLUEPRINT_TRUST", str(store))
    assert await _names(root) == []


@pytest.mark.asyncio
async def test_missing_store_file_fails_closed(tmp_path: Path, monkeypatch):
    """Env set but no store written yet (fresh machine): nothing loads until
    the first apply/review creates it — never a silent free-for-all."""
    root = _skills_root(tmp_path)
    _write_skill(root, "reviewed", TRUSTED_MD)
    monkeypatch.setenv("SANAD_BLUEPRINT_TRUST", str(tmp_path / "blueprint-trust.json"))
    assert await _names(root) == []
