"""sanad agent — worker-agent verbs (dev now; deploy/runs/logs/pause/resume in Task 9)."""

import asyncio
import json
import os
import tempfile
from pathlib import Path
from typing import TYPE_CHECKING, Annotated

import typer

if TYPE_CHECKING:
    from kimi_cli.app import KimiCLI

cli = typer.Typer(help="Deploy and operate worker agents.")


@cli.callback()
def agent_group() -> None:
    """Deploy and operate worker agents."""
    # Typer collapses a group with exactly one registered command into that
    # command directly (see typer.main.get_command), which would make `kimi
    # agent dev` parse `dev` as a stray positional argument to `agent` itself.
    # An explicit callback forces Group mode so `dev` stays a real subcommand
    # name now, ahead of Task 9 adding deploy/runs/logs/pause/resume.


EXIT_OK = 0
EXIT_FAILURE = 1
EXIT_NO_OUTPUT = 3
EXIT_BAD_INPUT = 4

NUDGE = (
    "You have not called the ReturnOutput tool. Call it now with the declared outputs. "
    "This is your final step."
)


@cli.command()
def dev(
    input_json: Annotated[str, typer.Option("--input", help="Run input as JSON.")],
    agent_file: Annotated[Path, typer.Option("--agent-file")] = Path("agent.yaml"),
    worker_file: Annotated[Path, typer.Option("--worker-file")] = Path("worker.yaml"),
    work_dir: Annotated[Path, typer.Option("--work-dir")] = Path("."),
    config_file: Annotated[Path | None, typer.Option("--config-file")] = None,
) -> None:
    """Run the worker once locally with the same assembly the cloud runner uses."""
    raise typer.Exit(asyncio.run(_dev(input_json, agent_file, worker_file, work_dir, config_file)))


async def _dev(
    input_json: str,
    agent_file: Path,
    worker_file: Path,
    work_dir: Path,
    config_file: Path | None,
) -> int:
    from kimi_cli.worker import (
        WorkerInputError,
        WorkerSpecError,
        derive_agent_spec,
        load_worker_spec,
        render_input_prompt,
    )

    work_dir = work_dir.resolve()
    try:
        spec = load_worker_spec((work_dir / worker_file).resolve())
        prompt = render_input_prompt(spec, json.loads(input_json))
    except (WorkerInputError, WorkerSpecError, json.JSONDecodeError) as e:
        typer.echo(f"error: {e}", err=True)
        return EXIT_BAD_INPUT

    with tempfile.TemporaryDirectory(prefix="sanad-worker-") as tmp:
        out_file = Path(tmp) / "output.json"
        # Set env before KimiCLI.create (toolset loads tools at create time) so the
        # ReturnOutput tool sees KIMI_WORKER_INTERFACE_FILE/KIMI_WORKER_OUTPUT_FILE
        # at call time regardless of when it reads them.
        os.environ["KIMI_WORKER_INTERFACE_FILE"] = str((work_dir / worker_file).resolve())
        os.environ["KIMI_WORKER_OUTPUT_FILE"] = str(out_file)
        derived = derive_agent_spec((work_dir / agent_file).resolve(), Path(tmp))

        from kaos.path import KaosPath

        from kimi_cli.app import KimiCLI
        from kimi_cli.session import Session

        session = await Session.create(KaosPath(str(work_dir)))
        cli_app = await KimiCLI.create(
            session,
            config=config_file,
            runtime_afk=True,
            ui_mode="print",
            agent_file=derived,
            max_steps_per_turn=spec.budgets.max_steps_per_turn,
        )
        status = await _one_turn(cli_app, prompt, spec.budgets.max_turn_seconds)
        if status != 0:
            return status
        if not out_file.exists():
            # One nudge, then give up (spec: nudge-retry then fail no_output).
            status = await _one_turn(cli_app, NUDGE, spec.budgets.max_turn_seconds)
            if status != 0:
                return status
        if not out_file.exists():
            typer.echo("error: run finished without calling ReturnOutput", err=True)
            return EXIT_NO_OUTPUT
        typer.echo(out_file.read_text(encoding="utf-8"))
        return EXIT_OK


async def _one_turn(cli_app: "KimiCLI", prompt: str, max_seconds: int) -> int:
    cancel = asyncio.Event()
    try:
        async with asyncio.timeout(max_seconds):
            async for _msg in cli_app.run(prompt, cancel):
                pass
    except TimeoutError:
        typer.echo("error: turn budget exceeded", err=True)
        return EXIT_FAILURE
    except Exception as e:  # provider errors, RunCancelled, ...
        typer.echo(f"error: {e}", err=True)
        return EXIT_FAILURE
    return 0
