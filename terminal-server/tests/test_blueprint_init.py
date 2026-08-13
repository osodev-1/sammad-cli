"""Seeding an empty .sanad — the blueprint every project should start with."""

from pathlib import Path

from sanad_terminal.blueprint_init import ensure_blueprint


def test_creates_a_valid_project_blueprint(tmp_path: Path):
    root = tmp_path / "workspace"
    root.mkdir()

    created = ensure_blueprint(root)
    assert created is True
    manifest = root / ".sanad" / "sanad.yaml"
    assert manifest.is_file()
    # The CLI's project skills brand dir must exist so skills authored here load.
    assert (root / ".sanad" / "skills").is_dir()

    # The seed must be a VALID blueprint: the kernel indexes it to a Project
    # node with no blocking diagnostics.
    from sanad_blueprint.graph import compile_graph
    from sanad_blueprint.indexer import index_blueprint
    from sanad_blueprint.validate import validate_blueprint

    graph = compile_graph(index_blueprint(root / ".sanad")).to_dict()
    graph_nodes = graph["nodes"]
    assert isinstance(graph_nodes, list)
    assert any(n["id"] == "project:workspace" and n["kind"] == "Project" for n in graph_nodes)
    assert validate_blueprint(root / ".sanad").ok


def test_is_idempotent_and_never_overwrites(tmp_path: Path):
    root = tmp_path / "workspace"
    root.mkdir()
    ensure_blueprint(root)

    # A user/Architect edit to the manifest must survive a second boot.
    manifest = root / ".sanad" / "sanad.yaml"
    manifest.write_text(manifest.read_text() + "\n# edited by the user\n")

    created = ensure_blueprint(root)
    assert created is False
    assert "# edited by the user" in manifest.read_text()
