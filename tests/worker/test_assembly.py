from pathlib import Path

import pytest

from kimi_cli.worker.assembly import WorkerInputError, derive_agent_spec, render_input_prompt
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


def test_derived_spec_extends_and_adds_tool(tmp_path: Path) -> None:
    agent = tmp_path / "agent.yaml"
    agent.write_text("version: '1'\nname: test\nsystem_prompt_path: prompt.md\n")
    (tmp_path / "prompt.md").write_text("hi")
    derived = derive_agent_spec(agent, tmp_path / "out")
    text = derived.read_text()
    assert str(agent) in text
    assert "kimi_cli.worker.return_output:ReturnOutput" in text
