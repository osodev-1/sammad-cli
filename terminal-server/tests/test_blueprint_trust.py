"""Trust store unit behavior: states, content-addressing, fail-safe corruption."""

import json
from pathlib import Path

from sanad_terminal.blueprint_trust import (
    TRUST_FILE_NAME,
    file_sha256,
    is_executable_path,
    load_trust,
    record_trust,
    trust_file_for,
    trust_statuses,
)


def _workspace(tmp_path: Path) -> Path:
    root = tmp_path / "user" / "workspace"
    (root / ".sanad" / "skills").mkdir(parents=True)
    return root


def _write_skill(root: Path, slug: str, body: str) -> Path:
    d = root / ".sanad" / "skills" / slug
    d.mkdir(parents=True, exist_ok=True)
    p = d / "SKILL.md"
    p.write_text(body, encoding="utf-8")
    return p


def test_store_lives_outside_the_workspace(tmp_path: Path):
    root = _workspace(tmp_path)
    f = trust_file_for(root)
    assert f == tmp_path / "user" / TRUST_FILE_NAME
    assert ".sanad" not in f.parts and "workspace" not in f.parts


def test_executable_path_matcher_gates_only_skill_instructions():
    assert is_executable_path(".sanad/skills/code-review/SKILL.md")
    assert not is_executable_path(".sanad/skills/code-review/skill.yaml")  # declarative
    assert not is_executable_path(".sanad/agents/primary/agent.yaml")
    assert not is_executable_path("docs/SKILL.md")  # outside .sanad
    assert not is_executable_path(".sanad/skills/a/b/SKILL.md")  # too deep
    assert not is_executable_path(".sanad/skills/../SKILL.md")  # traversal slug


def test_lifecycle_untrusted_then_trusted_then_changed(tmp_path: Path):
    root = _workspace(tmp_path)
    skill = _write_skill(root, "review", "---\nname: review\n---\nDo the review.\n")
    rel = ".sanad/skills/review/SKILL.md"

    assert trust_statuses(root)[rel]["status"] == "untrusted"

    record_trust(root, {rel: file_sha256(skill)}, "apply")
    status = trust_statuses(root)[rel]
    assert status["status"] == "trusted"
    assert status["source"] == "apply"

    skill.write_text("---\nname: review\n---\nEDITED after review.\n", encoding="utf-8")
    assert trust_statuses(root)[rel]["status"] == "changed"


def test_record_merges_and_survives_reload(tmp_path: Path):
    root = _workspace(tmp_path)
    a = _write_skill(root, "a", "A instructions")
    b = _write_skill(root, "b", "B instructions")
    record_trust(root, {".sanad/skills/a/SKILL.md": file_sha256(a)}, "apply")
    record_trust(root, {".sanad/skills/b/SKILL.md": file_sha256(b)}, "manual")

    entries = load_trust(root)
    assert entries[".sanad/skills/a/SKILL.md"]["source"] == "apply"
    assert entries[".sanad/skills/b/SKILL.md"]["source"] == "manual"


def test_corrupt_store_reads_empty_and_fails_safe(tmp_path: Path):
    root = _workspace(tmp_path)
    skill = _write_skill(root, "x", "content")
    record_trust(root, {".sanad/skills/x/SKILL.md": file_sha256(skill)}, "apply")
    trust_file_for(root).write_text("{not json", encoding="utf-8")

    assert load_trust(root) == {}
    # Fail SAFE: with the store unreadable everything reverts to untrusted.
    assert trust_statuses(root)[".sanad/skills/x/SKILL.md"]["status"] == "untrusted"


def test_deleted_file_drops_out_of_statuses(tmp_path: Path):
    root = _workspace(tmp_path)
    skill = _write_skill(root, "gone", "bye")
    rel = ".sanad/skills/gone/SKILL.md"
    record_trust(root, {rel: file_sha256(skill)}, "apply")
    skill.unlink()
    assert rel not in trust_statuses(root)


def test_store_shape_is_versioned_json(tmp_path: Path):
    root = _workspace(tmp_path)
    s = _write_skill(root, "v", "vv")
    record_trust(root, {".sanad/skills/v/SKILL.md": file_sha256(s)}, "apply")
    data = json.loads(trust_file_for(root).read_text(encoding="utf-8"))
    assert data["version"] == 1
    assert set(data["entries"][".sanad/skills/v/SKILL.md"]) == {"sha256", "trustedAt", "source"}
