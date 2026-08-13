"""worker.yaml — the P0 interface/budget sidecar (replaced by manifest-v1's stanzas)."""

from pathlib import Path

import yaml
from pydantic import BaseModel, Field, field_validator


class WorkerSpecError(Exception):
    pass


class InterfaceSpec(BaseModel):
    inputs: dict[str, str] = Field(default_factory=dict)
    outputs: dict[str, str] = Field(default_factory=dict)

    @field_validator("inputs", "outputs")
    @classmethod
    def _no_empty_types(cls, v: dict[str, str]) -> dict[str, str]:
        for key, typ in v.items():
            if not key or not typ.strip():
                raise ValueError(f"empty type for {key!r}")
        return v


class BudgetSpec(BaseModel):
    max_turn_seconds: int = 900
    max_steps_per_turn: int = 100
    max_tokens_per_run: int = 2_000_000


class WorkerSpec(BaseModel):
    interface: InterfaceSpec = Field(default_factory=InterfaceSpec)
    budgets: BudgetSpec = Field(default_factory=BudgetSpec)


def load_worker_spec(path: Path) -> WorkerSpec:
    try:
        raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    except FileNotFoundError as e:
        raise WorkerSpecError(f"worker spec not found: {path}") from e
    except yaml.YAMLError as e:
        raise WorkerSpecError(f"invalid YAML in {path}: {e}") from e
    try:
        return WorkerSpec.model_validate(raw or {})
    except ValueError as e:
        raise WorkerSpecError(str(e)) from e
