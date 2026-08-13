"""The worker interface contract: declared outputs come back through this tool."""

import json
import os
from pathlib import Path
from typing import Any, override

from kosong.tooling import CallableTool2, ToolReturnValue
from pydantic import BaseModel, Field

from kimi_cli.soul.toolset import KimiToolset
from kimi_cli.worker.sidecar import load_worker_spec


class Params(BaseModel):
    output: dict[str, Any] = Field(description="The declared output document for this run.")


class ReturnOutput(CallableTool2[Params]):
    name: str = "ReturnOutput"
    description: str = (
        "Return the run's final output document. Call exactly once, with every declared "
        "output key, when the task is complete. This ends the run."
    )
    params: type[Params] = Params

    def __init__(self, toolset: KimiToolset) -> None:
        super().__init__()
        self._toolset = toolset

    @override
    async def __call__(self, params: Params) -> ToolReturnValue:
        spec = load_worker_spec(Path(os.environ["KIMI_WORKER_INTERFACE_FILE"]))
        declared = set(spec.interface.outputs)
        given = set(params.output)
        if declared and (given != declared):
            message = (
                f"Output keys {sorted(given)} do not match declared outputs "
                f"{sorted(declared)}. Call ReturnOutput again with exactly the "
                "declared keys."
            )
            return ToolReturnValue(
                is_error=True,
                output=message,
                message=message,
                display=[],
            )
        out_file = Path(os.environ["KIMI_WORKER_OUTPUT_FILE"])
        out_file.write_text(json.dumps(params.output, ensure_ascii=False), encoding="utf-8")
        self._toolset.request_stop_turn()
        return ToolReturnValue(
            is_error=False,
            output="Output recorded. The run is complete.",
            message="Output recorded. The run is complete.",
            display=[],
        )
