"""Run assembly shared by `sanad dev` (local) and the cloud RunRunner — parity by construction."""

import json
from pathlib import Path
from typing import Any

import yaml

from kimi_cli.agentspec import load_agent_spec
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
    """Write a derived agent spec that extends `agent_file` and adds ReturnOutput.

    Two things the naive `{extend: ..., tools: [ReturnOutput]}` shape gets wrong:

    1. `extend` alone is not enough to keep the base tools: agentspec.py's
       extend-resolution treats a `tools` list on the extending spec as a full
       replacement of the base tools, not an addition (see `_load_agent_spec` in
       agentspec.py — only `system_prompt_args` is merged; `tools` is overwritten
       wholesale). So we resolve the base spec's tools here and explicitly restate
       them plus ReturnOutput, while still using `extend` for everything else
       (prompt, model, subagents, ...).
    2. The fields (`extend`, `tools`, ...) must be nested under an `agent:` key —
       `_load_agent_spec` reads `AgentSpec(**data.get("agent", {}))`, so a flat
       top-level `{extend: ..., tools: [...]}` document is silently ignored
       (treated as an empty spec) rather than raising, which would otherwise fail
       later with a confusing "Agent name is required".
    """
    base = load_agent_spec(agent_file)
    tools = list(base.tools)
    if RETURN_OUTPUT_TOOL not in tools:
        tools.append(RETURN_OUTPUT_TOOL)

    out_dir.mkdir(parents=True, exist_ok=True)
    derived = out_dir / "worker-agent.yaml"
    derived.write_text(
        yaml.safe_dump(
            {
                "version": "1",
                "agent": {"extend": str(agent_file.resolve()), "tools": tools},
            },
            sort_keys=False,
        ),
        encoding="utf-8",
    )
    return derived
