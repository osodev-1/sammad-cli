"""Scaffold templates — notably that a Skill's SKILL.md is CLI-loadable."""

from sanad_blueprint.schemas import ResourceKind
from sanad_blueprint.templates import render


def _files(kind: ResourceKind, rid: str, name: str) -> dict[str, str]:
    return {tf.rel: tf.content for tf in render(kind, rid, name)}


def test_skill_md_carries_cli_frontmatter():
    """The Kimi CLI reads .sanad/skills/<slug>/SKILL.md and keys on frontmatter
    name/description — so the scaffold must emit them (else the skill loads with
    the slug as name and the heading as description)."""
    files = _files(ResourceKind.SKILL, "skill:code-review", "Code Review")
    assert set(files) == {"skill.yaml", "SKILL.md"}
    md = files["SKILL.md"]
    assert md.startswith("---\n")
    _, frontmatter, body = md.split("---\n", 2)
    assert "name: code-review" in frontmatter  # the CLI skill id = the slug
    assert "description:" in frontmatter
    assert "# Code Review" in body


def test_other_kinds_unchanged():
    assert set(_files(ResourceKind.AGENT, "agent:primary", "Primary")) == {
        "agent.yaml",
        "prompt.md",
    }
    assert set(_files(ResourceKind.TOOL, "tool:files", "Files")) == {"tool.yaml"}
    assert set(_files(ResourceKind.POLICY, "policy:p", "P")) == {"policy.yaml"}
