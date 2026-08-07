"""Kernel tests — parse, index, compile, validate, and the reconstruction
invariant (delete cache → identical graph, NF-005/GR-001)."""

from __future__ import annotations

from pathlib import Path

from sanad_blueprint.envelope import parse_manifest
from sanad_blueprint.graph import compile_graph
from sanad_blueprint.indexer import index_blueprint
from sanad_blueprint.schemas import ResourceKind, json_schemas
from sanad_blueprint.validate import validate_blueprint

FIXTURE = Path(__file__).parent / "fixtures" / "basic" / ".sanad"


def test_index_finds_all_resources() -> None:
    index = index_blueprint(FIXTURE)
    assert set(index.resources) == {
        "project:sanad-code",
        "agent:primary",
        "skill:code-review",
        "tool:workspace-files",
        "policy:safe-workspace",
    }
    # Supporting files attach to their owning resource.
    agent = index.resources["agent:primary"]
    assert any(p.endswith("prompt.md") for p in agent.supporting_paths)


def test_graph_derives_typed_edges() -> None:
    graph = compile_graph(index_blueprint(FIXTURE))
    edges = {(e.source, e.type, e.target) for e in graph.edges}
    assert ("agent:primary", "uses", "skill:code-review") in edges
    assert ("agent:primary", "invokes", "tool:workspace-files") in edges
    assert ("agent:primary", "governed_by", "policy:safe-workspace") in edges
    assert ("skill:code-review", "invokes", "tool:workspace-files") in edges
    assert not any(e.broken for e in graph.edges)


def test_valid_fixture_has_no_blocking_diagnostics() -> None:
    report = validate_blueprint(FIXTURE)
    assert report.ok, [d.model_dump() for d in report.blocking]


def test_reconstruction_is_deterministic() -> None:
    """The graph is a pure function of the files (NF-005)."""
    a = compile_graph(index_blueprint(FIXTURE)).to_dict()
    b = compile_graph(index_blueprint(FIXTURE)).to_dict()
    assert a == b


def test_malformed_yaml_becomes_a_diagnostic_not_a_crash() -> None:
    parsed = parse_manifest(".sanad/agents/x/agent.yaml", "kind: Agent\n  bad: : :")
    assert not parsed.ok
    assert any(d.code == "yaml_syntax" for d in parsed.diagnostics)


def test_unknown_kind_is_reported() -> None:
    parsed = parse_manifest(
        ".sanad/x/thing.yaml",
        "apiVersion: sanad.dev/v1alpha1\nkind: Wizard\nmetadata:\n  id: x:y\n  name: Y\nspec: {}\n",
    )
    assert not parsed.ok
    assert any(d.code == "unknown_kind" for d in parsed.diagnostics)


def test_broken_reference_is_visible_and_blocking() -> None:
    parsed = parse_manifest(
        ".sanad/agents/p/agent.yaml",
        "apiVersion: sanad.dev/v1alpha1\nkind: Agent\n"
        "metadata:\n  id: agent:p\n  name: P\n"
        "spec:\n  skills:\n    - skill:does-not-exist\n",
    )
    assert parsed.ok  # the manifest itself is valid...
    # ...but compiling a one-node index surfaces the dangling edge.
    from sanad_blueprint.indexer import BlueprintIndex, IndexedResource

    index = BlueprintIndex(root="/tmp/.sanad")
    index.resources["agent:p"] = IndexedResource(
        resource=parsed.resource, manifest_path=parsed.path
    )
    graph = compile_graph(index)
    broken = [e for e in graph.edges if e.broken]
    assert len(broken) == 1
    assert broken[0].target == "skill:does-not-exist"
    assert any(d.code == "unresolved_reference" for d in graph.diagnostics)


def test_delegation_cycle_is_blocking() -> None:
    from sanad_blueprint.indexer import BlueprintIndex, IndexedResource

    def agent(rid: str, delegates: list[str]):
        p = parse_manifest(
            f".sanad/agents/{rid}/agent.yaml",
            f"apiVersion: sanad.dev/v1alpha1\nkind: Agent\n"
            f"metadata:\n  id: agent:{rid}\n  name: {rid}\n"
            f"spec:\n  delegatesTo:\n" + "".join(f"    - agent:{d}\n" for d in delegates),
        )
        return IndexedResource(resource=p.resource, manifest_path=p.path)

    index = BlueprintIndex(root="/tmp/.sanad")
    index.resources["agent:a"] = agent("a", ["b"])
    index.resources["agent:b"] = agent("b", ["a"])
    graph = compile_graph(index)
    assert any(d.code == "delegation_cycle" for d in graph.diagnostics)


def test_duplicate_id_is_reported(tmp_path: Path) -> None:
    sanad = tmp_path / ".sanad"
    for folder in ("one", "two"):
        d = sanad / "skills" / folder
        d.mkdir(parents=True)
        (d / "skill.yaml").write_text(
            "apiVersion: sanad.dev/v1alpha1\nkind: Skill\n"
            "metadata:\n  id: skill:dup\n  name: Dup\nspec: {}\n"
        )
    index = index_blueprint(sanad)
    assert any(d.code == "duplicate_id" for d in index.diagnostics)


def test_json_schema_export_covers_every_kind() -> None:
    schemas = json_schemas()
    assert set(schemas) == {k.value for k in ResourceKind}
    for schema in schemas.values():
        assert schema["type"] == "object"
