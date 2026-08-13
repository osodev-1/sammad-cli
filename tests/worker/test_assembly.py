from pathlib import Path

import pytest

from kimi_cli.agentspec import load_agent_spec
from kimi_cli.worker.assembly import (
    RETURN_OUTPUT_TOOL,
    WorkerInputError,
    derive_agent_spec,
    render_input_prompt,
)
from kimi_cli.worker.sidecar import load_worker_spec


def _spec(tmp_path: Path):
    p = tmp_path / "worker.yaml"
    p.write_text("interface:\n  inputs: {invoice_no: string}\n  outputs: {decision: string}\n")
    return load_worker_spec(p)


def test_render_is_deterministic(tmp_path: Path) -> None:
    spec = _spec(tmp_path)
    out = render_input_prompt(spec, {"invoice_no": "INV-1"})
    assert "<worker_inputs>" in out
    assert '"invoice_no": "INV-1"' in out
    assert "ReturnOutput tool exactly once" in out
    assert out == render_input_prompt(spec, {"invoice_no": "INV-1"})


def test_unknown_input_rejected(tmp_path: Path) -> None:
    with pytest.raises(WorkerInputError):
        render_input_prompt(_spec(tmp_path), {"bogus": 1})


def test_missing_input_rejected(tmp_path: Path) -> None:
    with pytest.raises(WorkerInputError):
        render_input_prompt(_spec(tmp_path), {})


def _agent_with_tools(tmp_path: Path) -> Path:
    agent = tmp_path / "agent.yaml"
    agent.write_text(
        "version: '1'\n"
        "agent:\n"
        "  name: test\n"
        "  system_prompt_path: prompt.md\n"
        "  tools:\n"
        "    - kimi_cli.tools.shell:Shell\n"
    )
    (tmp_path / "prompt.md").write_text("hi")
    return agent


def test_derived_spec_extends_and_adds_tool(tmp_path: Path) -> None:
    agent = _agent_with_tools(tmp_path)
    derived = derive_agent_spec(agent, tmp_path / "out")
    text = derived.read_text()
    assert str(agent) in text
    assert "kimi_cli.worker.return_output:ReturnOutput" in text

    # The real contract: base tools must survive through the derived spec once
    # loaded via the actual agentspec machinery, not just appear as raw text.
    # extend's `tools` field is a full replacement (see agentspec.py), so a naive
    # `{extend: ..., tools: [ReturnOutput]}` would silently drop Shell et al.
    base = load_agent_spec(agent)
    resolved = load_agent_spec(derived)
    assert resolved.tools == [*base.tools, RETURN_OUTPUT_TOOL]


def test_rederiving_does_not_duplicate_return_output(tmp_path: Path) -> None:
    agent = _agent_with_tools(tmp_path)
    out_dir = tmp_path / "out"
    first = derive_agent_spec(agent, out_dir)
    second = derive_agent_spec(first, out_dir / "again")
    resolved = load_agent_spec(second)
    assert resolved.tools.count(RETURN_OUTPUT_TOOL) == 1
