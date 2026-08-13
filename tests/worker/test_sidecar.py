from pathlib import Path

import pytest

from kimi_cli.worker.sidecar import WorkerSpec, WorkerSpecError, load_worker_spec

VALID = """\
interface:
  inputs: {invoice_no: string, amount: number}
  outputs: {decision: "enum[approve, hold]", summary: string}
budgets:
  max_turn_seconds: 60
"""


def test_load_valid(tmp_path: Path) -> None:
    p = tmp_path / "worker.yaml"
    p.write_text(VALID)
    spec: WorkerSpec = load_worker_spec(p)
    assert spec.interface.inputs == {"invoice_no": "string", "amount": "number"}
    assert spec.budgets.max_turn_seconds == 60
    assert spec.budgets.max_steps_per_turn == 100  # default


def test_missing_file(tmp_path: Path) -> None:
    with pytest.raises(WorkerSpecError):
        load_worker_spec(tmp_path / "nope.yaml")


def test_empty_output_type_rejected(tmp_path: Path) -> None:
    p = tmp_path / "worker.yaml"
    p.write_text('interface:\n  inputs: {}\n  outputs: {decision: ""}\n')
    with pytest.raises(WorkerSpecError):
        load_worker_spec(p)
