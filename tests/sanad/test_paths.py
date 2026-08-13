"""sanad stores its data under ~/.sanad, never ~/.kimi (governance/brand)."""

from __future__ import annotations

from pathlib import Path


def test_share_dir_defaults_to_dot_sanad(tmp_path, monkeypatch):
    monkeypatch.delenv("KIMI_SHARE_DIR", raising=False)
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    from kimi_cli.share import get_share_dir

    d = get_share_dir()
    assert d == tmp_path / ".sanad"
    assert ".kimi" not in str(d)


def test_config_file_lives_under_dot_sanad(tmp_path, monkeypatch):
    monkeypatch.delenv("KIMI_SHARE_DIR", raising=False)
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    from kimi_cli.config import get_config_file

    assert get_config_file() == tmp_path / ".sanad" / "config.toml"


def test_plans_dir_is_under_dot_sanad():
    from kimi_cli.tools.plan.heroes import PLANS_DIR

    assert PLANS_DIR.name == "plans"
    assert PLANS_DIR.parent.name == ".sanad"
    assert ".kimi" not in str(PLANS_DIR)


def test_skill_brand_dir_is_sanad_not_kimi():
    # The user + project brand skill search paths use .sanad/skills, never
    # .kimi/skills (the .claude / .codex borrow-dirs are kept).
    from kaos.path import KaosPath

    from kimi_cli.skill import (
        _get_project_brand_skills_dir_candidates,
        _get_user_brand_skills_dir_candidates,
    )

    user = " ".join(str(p) for p in _get_user_brand_skills_dir_candidates())
    proj = " ".join(
        str(p)
        for p in _get_project_brand_skills_dir_candidates(
            KaosPath.unsafe_from_local_path(Path("/tmp/p"))
        )
    )
    assert ".sanad/skills" in user and ".kimi" not in user
    assert ".sanad/skills" in proj and ".kimi" not in proj
