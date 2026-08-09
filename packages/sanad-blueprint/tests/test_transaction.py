"""Transaction tests: plan → apply → reindex, preconditions, rollback."""

from __future__ import annotations

from pathlib import Path

import pytest
from sanad_blueprint.graph import compile_graph
from sanad_blueprint.indexer import index_blueprint
from sanad_blueprint.schemas import ResourceKind
from sanad_blueprint.transaction import (
    ChangePlan,
    Operation,
    PlanError,
    Precondition,
    apply_plan,
    plan_create_edge,
    plan_create_resource,
    plan_write_files,
    rollback,
)


def _sanad(tmp: Path) -> Path:
    d = tmp / ".sanad"
    (d / "agents" / "primary").mkdir(parents=True)
    (d / "agents" / "primary" / "agent.yaml").write_text(
        "apiVersion: sanad.dev/v1alpha1\nkind: Agent\n"
        "metadata:\n  id: agent:primary\n  name: Primary\nspec: {}\n"
    )
    return d


def test_create_resource_writes_and_indexes(tmp_path: Path):
    sanad = _sanad(tmp_path)
    index = index_blueprint(sanad)
    plan = plan_create_resource(index, ResourceKind.SKILL, "Code Review")
    assert plan.nodes_added == ["skill:code-review"]
    assert {op.path for op in plan.operations} == {
        ".sanad/skills/code-review/skill.yaml",
        ".sanad/skills/code-review/SKILL.md",
    }

    apply_plan(tmp_path, plan)
    reindexed = index_blueprint(sanad)
    assert "skill:code-review" in reindexed.resources


def test_create_resource_rejects_duplicate(tmp_path: Path):
    sanad = _sanad(tmp_path)
    index = index_blueprint(sanad)
    with pytest.raises(PlanError) as e:
        plan_create_resource(index, ResourceKind.AGENT, "Primary")
    assert e.value.code == "duplicate_id"


def test_create_edge_patches_manifest(tmp_path: Path):
    sanad = _sanad(tmp_path)
    # add a skill to reference
    apply_plan(tmp_path, plan_create_resource(index_blueprint(sanad), ResourceKind.SKILL, "Review"))
    index = index_blueprint(sanad)
    plan = plan_create_edge(index, "agent:primary", "skill:review", "uses")
    assert plan.edges_added == [{"from": "agent:primary", "type": "uses", "to": "skill:review"}]

    apply_plan(tmp_path, plan)
    graph = compile_graph(index_blueprint(sanad))
    edges = {(e.source, e.type, e.target) for e in graph.edges}
    assert ("agent:primary", "uses", "skill:review") in edges


def test_create_edge_infers_type_when_omitted(tmp_path: Path):
    sanad = _sanad(tmp_path)
    apply_plan(tmp_path, plan_create_resource(index_blueprint(sanad), ResourceKind.SKILL, "Review"))
    index = index_blueprint(sanad)
    # No edge type given (drag-to-connect) → inferred as agent→skill "uses".
    plan = plan_create_edge(index, "agent:primary", "skill:review")
    assert plan.edges_added == [{"from": "agent:primary", "type": "uses", "to": "skill:review"}]


def test_create_edge_invalid_relationship(tmp_path: Path):
    sanad = _sanad(tmp_path)
    apply_plan(tmp_path, plan_create_resource(index_blueprint(sanad), ResourceKind.POLICY, "P"))
    index = index_blueprint(sanad)
    # An agent can't "uses" a policy — that would be governed_by.
    with pytest.raises(PlanError) as e:
        plan_create_edge(index, "agent:primary", "policy:p", "uses")
    assert e.value.code == "invalid_relationship"


def test_stale_precondition_aborts_without_partial_write(tmp_path: Path):
    sanad = _sanad(tmp_path)
    target = _seed_skill(tmp_path, sanad)  # create + persist BEFORE indexing
    index = index_blueprint(sanad)
    plan = plan_create_edge(index, "agent:primary", target, "uses")
    # Someone edits the manifest after the plan was drafted.
    manifest = sanad / "agents" / "primary" / "agent.yaml"
    manifest.write_text(manifest.read_text() + "\n# touched\n")

    with pytest.raises(PlanError) as e:
        apply_plan(tmp_path, plan)
    assert e.value.code == "stale_plan"
    # The manifest is untouched by the failed apply (still has our marker).
    assert "# touched" in manifest.read_text()


def test_create_precondition_blocks_overwrite(tmp_path: Path):
    sanad = _sanad(tmp_path)
    plan = plan_create_resource(index_blueprint(sanad), ResourceKind.TOOL, "Files")
    apply_plan(tmp_path, plan)  # first apply succeeds
    with pytest.raises(PlanError) as e:
        apply_plan(tmp_path, plan)  # second must refuse (file now exists)
    assert e.value.code == "precondition_failed"


def test_rollback_undoes_a_create(tmp_path: Path):
    sanad = _sanad(tmp_path)
    plan = plan_create_resource(index_blueprint(sanad), ResourceKind.TOOL, "Files")
    result = apply_plan(tmp_path, plan)
    assert "tool:files" in index_blueprint(sanad).resources
    rollback(tmp_path, result.rollback)
    assert "tool:files" not in index_blueprint(sanad).resources


def _seed_skill(tmp_path: Path, sanad: Path) -> str:
    apply_plan(tmp_path, plan_create_resource(index_blueprint(sanad), ResourceKind.SKILL, "Seed"))
    return "skill:seed"


# ------------------------------------------------- plan_write_files (S9) ---


SKILL_MANIFEST = (
    "apiVersion: sanad.dev/v1alpha1\nkind: Skill\n"
    "metadata:\n  id: skill:code-review\n  name: Code Review\n"
    "spec:\n  description: Reviews diffs for correctness\n"
)


def test_write_files_creates_with_real_content(tmp_path: Path):
    sanad = _sanad(tmp_path)
    plan = plan_write_files(
        index_blueprint(sanad),
        [
            (".sanad/skills/code-review/skill.yaml", SKILL_MANIFEST),
            (".sanad/skills/code-review/SKILL.md", "# Code Review\n\nCheck every diff.\n"),
        ],
        "Define the Code Review skill",
    )
    assert plan.nodes_added == ["skill:code-review"]
    assert plan.nodes_changed == []
    assert all(p.sha256 is None for p in plan.preconditions)  # both are creates
    apply_plan(tmp_path, plan)
    reindexed = index_blueprint(sanad)
    assert "skill:code-review" in reindexed.resources
    md = (tmp_path / ".sanad/skills/code-review/SKILL.md").read_text()
    assert "Check every diff." in md  # the author's content, not a template


def test_write_files_updates_with_disk_precondition(tmp_path: Path):
    sanad = _sanad(tmp_path)
    new_manifest = (
        "apiVersion: sanad.dev/v1alpha1\nkind: Agent\n"
        "metadata:\n  id: agent:primary\n  name: Primary\n"
        "spec:\n  description: The main agent\n"
    )
    plan = plan_write_files(
        index_blueprint(sanad),
        [(".sanad/agents/primary/agent.yaml", new_manifest)],
        "Describe the primary agent",
    )
    assert plan.nodes_added == []
    assert plan.nodes_changed == ["agent:primary"]
    [op] = plan.operations
    assert op.op == "update"
    [pre] = plan.preconditions
    assert pre.sha256 is not None  # hashed from disk
    apply_plan(tmp_path, plan)
    assert "The main agent" in (tmp_path / ".sanad/agents/primary/agent.yaml").read_text()


def test_write_files_stale_disk_fails_apply(tmp_path: Path):
    sanad = _sanad(tmp_path)
    plan = plan_write_files(
        index_blueprint(sanad),
        [(".sanad/agents/primary/agent.yaml", SKILL_MANIFEST.replace("skill:code-review", "agent:primary").replace("kind: Skill", "kind: Agent"))],
        "Edit",
    )
    (tmp_path / ".sanad/agents/primary/agent.yaml").write_text("changed: behind-your-back\n")
    with pytest.raises(PlanError) as e:
        apply_plan(tmp_path, plan)
    assert e.value.code == "stale_plan"


def test_write_files_rejects_escape_and_bad_manifests(tmp_path: Path):
    sanad = _sanad(tmp_path)
    index = index_blueprint(sanad)
    for bad in ("../blueprint-trust.json", "/etc/passwd", "src/app.py", ".sanad/../x"):
        with pytest.raises(PlanError) as e:
            plan_write_files(index, [(bad, "x")], "s")
        assert e.value.code == "invalid_path"
    with pytest.raises(PlanError) as e:
        plan_write_files(index, [(".sanad/skills/x/skill.yaml", "kind: [broken")], "s")
    assert e.value.code == "manifest_invalid"
    # Duplicate id vs the index; and an update must keep its id.
    with pytest.raises(PlanError) as e:
        plan_write_files(
            index,
            [(".sanad/agents/other/agent.yaml", SKILL_MANIFEST.replace("kind: Skill", "kind: Agent").replace("skill:code-review", "agent:primary"))],
            "s",
        )
    assert e.value.code == "duplicate_id"
    with pytest.raises(PlanError) as e:
        plan_write_files(
            index,
            [(".sanad/agents/primary/agent.yaml", SKILL_MANIFEST.replace("kind: Skill", "kind: Agent").replace("skill:code-review", "agent:renamed"))],
            "s",
        )
    assert e.value.code == "id_changed"


def test_apply_rejects_paths_outside_sanad(tmp_path: Path):
    _sanad(tmp_path)
    evil = ChangePlan(
        summary="evil",
        operations=[Operation(op="create", path="../blueprint-trust.json", content="{}")],
        preconditions=[Precondition(path="../blueprint-trust.json", sha256=None)],
    )
    with pytest.raises(PlanError) as e:
        apply_plan(tmp_path, evil)
    assert e.value.code == "invalid_path"
    assert not (tmp_path.parent / "blueprint-trust.json").exists()
