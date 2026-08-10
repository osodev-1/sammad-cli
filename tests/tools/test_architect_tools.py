"""The Sanad Architect's blueprint tools: read + draft only, governed by omission.

These assert the two things M3 relies on: (1) the architect agent spec has no
tool that can write or apply — governance is structural; (2) the tools inspect
and DRAFT against the workspace ``.sanad`` in-process, producing the exact
``ChangePlan`` shape the M2 apply endpoint consumes.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, cast

import pytest
from kosong.tooling import ToolReturnValue

from kimi_cli.sanad.architect_tools import (
    BlueprintGraph,
    BlueprintValidate,
    DraftBlueprintChange,
    DraftParams,
    FileDraft,
)
from kimi_cli.soul.agent import Runtime

AGENT = (
    "apiVersion: sanad.dev/v1alpha1\nkind: Agent\n"
    "metadata:\n  id: agent:primary\n  name: Primary\nspec: {}\n"
)


class _WorkDir:
    def __init__(self, p: Path) -> None:
        self._p = p

    def unsafe_to_local_path(self) -> Path:
        return self._p


class _Runtime:
    """The only runtime surface the tools touch: builtin_args.KIMI_WORK_DIR."""

    def __init__(self, work_dir: Path) -> None:
        self.builtin_args = type("_Args", (), {"KIMI_WORK_DIR": _WorkDir(work_dir)})()


@pytest.fixture
def workspace(tmp_path: Path) -> Path:
    d = tmp_path / ".sanad" / "agents" / "primary"
    d.mkdir(parents=True)
    (d / "agent.yaml").write_text(AGENT)
    return tmp_path


def _rt(root: Path) -> Runtime:
    # The tools only touch builtin_args.KIMI_WORK_DIR; a duck-typed stub suffices.
    return cast("Runtime", _Runtime(root))


def _plan(res: ToolReturnValue) -> dict[str, Any]:
    """The drafted ChangePlan the tool attaches for the UI (extras.blueprintPlan)."""
    assert res.extras is not None
    return cast("dict[str, Any]", res.extras["blueprintPlan"])


def test_tools_load_through_dependency_injection(tmp_path: Path):
    """The toolset instantiates the tools via type-matched DI — the path that a
    stray ``from __future__ import annotations`` would silently break."""
    from kimi_cli.soul.agent import Runtime
    from kimi_cli.soul.toolset import KimiToolset

    toolset = KimiToolset()
    toolset.load_tools(
        [
            "kimi_cli.sanad.architect_tools:BlueprintGraph",
            "kimi_cli.sanad.architect_tools:BlueprintValidate",
            "kimi_cli.sanad.architect_tools:DraftBlueprintChange",
        ],
        {Runtime: _rt(tmp_path)},  # stub is duck-typed; the key is the real type
    )
    assert toolset.find("BlueprintGraph") is not None
    assert toolset.find("DraftBlueprintChange") is not None


def test_agent_spec_is_structurally_governed():
    """The architect can read and draft, but has no tool that mutates."""
    from kimi_cli.agentspec import ARCHITECT_AGENT_FILE, load_agent_spec

    spec = load_agent_spec(ARCHITECT_AGENT_FILE)
    assert spec.name == "Sanad Architect"
    joined = " ".join(spec.tools)
    # Present: read + the three blueprint tools.
    assert "kimi_cli.tools.file:ReadFile" in spec.tools
    assert "kimi_cli.sanad.architect_tools:BlueprintGraph" in spec.tools
    assert "kimi_cli.sanad.architect_tools:DraftBlueprintChange" in spec.tools
    # Absent: anything that writes, runs, or applies.
    for forbidden in ("WriteFile", "StrReplaceFile", "Shell", "apply", "Apply"):
        assert forbidden not in joined, f"architect must not have a {forbidden} tool"


async def test_graph_tool_reads_the_blueprint(workspace: Path):
    import json

    res = await BlueprintGraph(_rt(workspace)).__call__(BlueprintGraph.params())
    assert not res.is_error
    graph = json.loads(cast("str", res.output))
    assert "agent:primary" in {n["id"] for n in graph["nodes"]}


async def test_validate_tool_flags_a_broken_reference(tmp_path: Path):
    import json

    d = tmp_path / ".sanad" / "agents" / "p"
    d.mkdir(parents=True)
    (d / "agent.yaml").write_text(
        "apiVersion: sanad.dev/v1alpha1\nkind: Agent\n"
        "metadata:\n  id: agent:p\n  name: P\n"
        "spec:\n  skills:\n    - skill:missing\n"
    )
    res = await BlueprintValidate(_rt(tmp_path)).__call__(BlueprintValidate.params())
    assert not res.is_error
    report = json.loads(cast("str", res.output))
    assert report["ok"] is False
    assert any(x["code"] == "unresolved_reference" for x in report["diagnostics"])


async def test_draft_resource_produces_an_m2_plan(workspace: Path):
    res = await DraftBlueprintChange(_rt(workspace)).__call__(
        DraftParams(action="createResource", kind="Skill", name="Code Review")
    )
    assert not res.is_error
    plan = _plan(res)
    # Exactly the shape M2's /apply consumes.
    assert set(plan) >= {"summary", "operations", "preconditions", "graphDelta"}
    assert plan["graphDelta"]["nodesAdded"] == ["skill:code-review"]
    assert {op["path"] for op in plan["operations"]} == {
        ".sanad/skills/code-review/skill.yaml",
        ".sanad/skills/code-review/SKILL.md",
    }


async def test_draft_edge_infers_relationship(workspace: Path):
    # Seed a skill on disk so the agent can connect to it.
    skill = workspace / ".sanad" / "skills" / "review"
    skill.mkdir(parents=True)
    (skill / "skill.yaml").write_text(
        "apiVersion: sanad.dev/v1alpha1\nkind: Skill\n"
        "metadata:\n  id: skill:review\n  name: Review\nspec: {}\n"
    )
    res = await DraftBlueprintChange(_rt(workspace)).__call__(
        DraftParams(action="createEdge", source="agent:primary", target="skill:review")
    )
    assert not res.is_error
    plan = _plan(res)
    assert plan["graphDelta"]["edgesAdded"] == [
        {"from": "agent:primary", "type": "uses", "to": "skill:review"}
    ]


async def test_draft_write_files_carries_real_content(workspace: Path):
    """writeFiles drafts substance — the author's exact contents, not a template
    — and edits to an existing manifest hash its current disk state (Scenario G)."""
    res = await DraftBlueprintChange(_rt(workspace)).__call__(
        DraftParams(
            action="writeFiles",
            summary="Define the Code Review skill and describe the primary agent",
            files=[
                FileDraft(
                    path=".sanad/skills/code-review/skill.yaml",
                    content=(
                        "apiVersion: sanad.dev/v1alpha1\nkind: Skill\n"
                        "metadata:\n  id: skill:code-review\n  name: Code Review\n"
                        "spec:\n  description: Reviews diffs for correctness\n"
                    ),
                ),
                FileDraft(
                    path=".sanad/skills/code-review/SKILL.md",
                    content="# Code Review\n\nRead the diff hunk by hunk.\n",
                ),
                FileDraft(
                    path=".sanad/agents/primary/agent.yaml",
                    content=(
                        "apiVersion: sanad.dev/v1alpha1\nkind: Agent\n"
                        "metadata:\n  id: agent:primary\n  name: Primary\n"
                        "spec:\n  description: The workspace's main agent\n"
                    ),
                ),
            ],
        )
    )
    assert not res.is_error
    plan = _plan(res)
    assert plan["graphDelta"]["nodesAdded"] == ["skill:code-review"]
    assert plan["graphDelta"]["nodesChanged"] == ["agent:primary"]
    by_path = {op["path"]: op for op in plan["operations"]}
    assert by_path[".sanad/skills/code-review/SKILL.md"]["content"].endswith("hunk by hunk.\n")
    assert by_path[".sanad/agents/primary/agent.yaml"]["op"] == "update"
    # The update's precondition is the CURRENT disk hash; the creates demand absence.
    pres = {p["path"]: p["sha256"] for p in plan["preconditions"]}
    assert pres[".sanad/agents/primary/agent.yaml"] is not None
    assert pres[".sanad/skills/code-review/skill.yaml"] is None


async def test_draft_delete_resource_cascades(workspace: Path):
    """deleteResource drafts the removal of a resource's files AND every
    reference to it — the review card shows exactly what disappears."""
    skill = workspace / ".sanad" / "skills" / "review"
    skill.mkdir(parents=True)
    (skill / "skill.yaml").write_text(
        "apiVersion: sanad.dev/v1alpha1\nkind: Skill\n"
        "metadata:\n  id: skill:review\n  name: Review\nspec: {}\n"
    )
    # The agent references the skill, so deletion must strip that edge too.
    (workspace / ".sanad" / "agents" / "primary" / "agent.yaml").write_text(
        "apiVersion: sanad.dev/v1alpha1\nkind: Agent\n"
        "metadata:\n  id: agent:primary\n  name: Primary\n"
        "spec:\n  skills:\n    - skill:review\n"
    )
    res = await DraftBlueprintChange(_rt(workspace)).__call__(
        DraftParams(action="deleteResource", id="skill:review")
    )
    assert not res.is_error
    plan = _plan(res)
    assert plan["graphDelta"]["nodesRemoved"] == ["skill:review"]
    assert {"from": "agent:primary", "type": "uses", "to": "skill:review"} in plan[
        "graphDelta"
    ]["edgesRemoved"]
    ops = {(o["op"], o["path"]) for o in plan["operations"]}
    assert ("delete", ".sanad/skills/review/skill.yaml") in ops
    assert ("update", ".sanad/agents/primary/agent.yaml") in ops


async def test_draft_write_files_delete_entry(workspace: Path):
    target = workspace / ".sanad" / "agents" / "primary" / "prompt.md"
    target.write_text("old prompt\n")
    res = await DraftBlueprintChange(_rt(workspace)).__call__(
        DraftParams(
            action="writeFiles",
            summary="Drop the stale prompt file",
            files=[FileDraft(path=".sanad/agents/primary/prompt.md", delete=True)],
        )
    )
    assert not res.is_error
    [op] = _plan(res)["operations"]
    assert op["op"] == "delete"

    # A write entry with neither content nor delete is a usage error.
    missing = await DraftBlueprintChange(_rt(workspace)).__call__(
        DraftParams(action="writeFiles", files=[FileDraft(path=".sanad/x.md")])
    )
    assert missing.is_error


async def test_draft_write_files_refuses_escape(workspace: Path):
    res = await DraftBlueprintChange(_rt(workspace)).__call__(
        DraftParams(
            action="writeFiles",
            files=[FileDraft(path="../blueprint-trust.json", content="{}")],
        )
    )
    assert res.is_error and res.brief == "invalid_path"

    missing = await DraftBlueprintChange(_rt(workspace)).__call__(
        DraftParams(action="writeFiles")
    )
    assert missing.is_error


async def test_draft_errors_are_results_not_exceptions(workspace: Path):
    tool = DraftBlueprintChange(_rt(workspace))

    unknown_target = await tool.__call__(
        DraftParams(action="createEdge", source="agent:primary", target="skill:nope")
    )
    assert unknown_target.is_error and unknown_target.brief == "unknown_target"

    unknown_kind = await tool.__call__(
        DraftParams(action="createResource", kind="Wormhole", name="x")
    )
    assert unknown_kind.is_error and "Creatable kinds" in unknown_kind.message

    missing = await tool.__call__(DraftParams(action="createResource", kind="Skill"))
    assert missing.is_error


async def test_tools_report_missing_blueprint(tmp_path: Path):
    rt = _rt(tmp_path)  # no .sanad here
    for res in (
        await BlueprintGraph(rt).__call__(BlueprintGraph.params()),
        await BlueprintValidate(rt).__call__(BlueprintValidate.params()),
        await DraftBlueprintChange(rt).__call__(
            DraftParams(action="createResource", kind="Skill", name="X")
        ),
    ):
        assert res.is_error and "blueprint" in res.message.lower()
