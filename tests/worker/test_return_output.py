import json
from pathlib import Path

import pytest

from kimi_cli.worker.return_output import Params, ReturnOutput


class FakeToolset:
    def __init__(self) -> None:
        self.stopped = False

    def request_stop_turn(self) -> None:
        self.stopped = True


def _env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    iface = tmp_path / "worker.yaml"
    iface.write_text("interface:\n  inputs: {}\n  outputs: {decision: string}\n")
    out_file = tmp_path / "output.json"
    monkeypatch.setenv("KIMI_WORKER_INTERFACE_FILE", str(iface))
    monkeypatch.setenv("KIMI_WORKER_OUTPUT_FILE", str(out_file))
    return out_file


async def test_writes_output_and_stops(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    out_file = _env(monkeypatch, tmp_path)
    toolset = FakeToolset()
    tool = ReturnOutput(toolset)  # type: ignore[arg-type]
    result = await tool(Params(output={"decision": "approve"}))
    assert not result.is_error
    assert json.loads(out_file.read_text()) == {"decision": "approve"}
    assert toolset.stopped


async def test_undeclared_output_key_errors(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    out_file = _env(monkeypatch, tmp_path)
    tool = ReturnOutput(FakeToolset())  # type: ignore[arg-type]
    result = await tool(Params(output={"bogus": 1}))
    assert result.is_error
    assert not out_file.exists()
