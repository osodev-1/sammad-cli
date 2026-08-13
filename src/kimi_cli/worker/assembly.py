"""Run assembly shared by `sanad dev` (local) and the cloud RunRunner — parity by construction."""

import json
from pathlib import Path
from typing import Any

import yaml

from kimi_cli.worker.sidecar import WorkerSpec

RETURN_OUTPUT_TOOL = "kimi_cli.worker.return_output:ReturnOutput"


class WorkerInputError(Exception):
    pass


def render_input_prompt(spec: WorkerSpec, payload: dict[str, Any]) -> str:
    declared = set(spec.interface.inputs)
    given = set(payload)
    if unknown := given - declared:
        raise WorkerInputError(f"unknown inputs: {sorted(unknown)}")
    if missing := declared - given:
        raise WorkerInputError(f"missing inputs: {sorted(missing)}")
    body = json.dumps(payload, sort_keys=True, ensure_ascii=False)
    outputs = ", ".join(sorted(spec.interface.outputs)) or "output"
    return (
        "Perform your task with these inputs:\n\n"
        f"<worker_inputs>\n{body}\n</worker_inputs>\n\n"
        "When the task is complete you MUST call the ReturnOutput tool "
        f"exactly once with the declared outputs: {outputs}."
    )


def derive_agent_spec(agent_file: Path, out_dir: Path) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    derived = out_dir / "worker-agent.yaml"
    derived.write_text(
        yaml.safe_dump(
            {"extend": str(agent_file.resolve()), "tools": [RETURN_OUTPUT_TOOL]},
            sort_keys=False,
        ),
        encoding="utf-8",
    )
    return derived
