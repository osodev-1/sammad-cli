"""sanad agent — worker-agent verbs: local dev run, plus the control-plane
deploy/runs/logs/pause/resume commands."""

import asyncio
import json
import os
import tempfile
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING, Annotated

import typer

if TYPE_CHECKING:
    from kimi_cli.app import KimiCLI
    from kimi_cli.sanad.client import SanadClient
    from kimi_cli.sanad.session import SanadSession

cli = typer.Typer(help="Deploy and operate worker agents.")


@cli.callback()
def agent_group() -> None:
    """Deploy and operate worker agents."""
    # Typer collapses a group with exactly one registered command into that
    # command directly (see typer.main.get_command), which would make `kimi
    # agent dev` parse `dev` as a stray positional argument to `agent` itself.
    # An explicit callback forces Group mode so each verb stays a real
    # subcommand name even while the group only had one command (dev).


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


# -- control-plane verbs (deploy/runs/logs/pause/resume) --------------------
#
# These talk to the sanad control plane over SanadClient, unlike `dev` above
# which runs entirely offline. Session-token resolution reuses
# SanadSession.require_token() (env SANAD_SESSION_TOKEN, falling back to the
# OS keychain — see KeychainStore.get()) rather than re-deriving that
# precedence here. `_build_session`/`_build_client` are seams: tests
# monkeypatch them to inject a fake keychain / MockTransport, the same
# pattern `kimi_cli.sanad.cli._build_session` uses.


def _build_session() -> "SanadSession":
    from kimi_cli.sanad.session import SanadSession
    from kimi_cli.sanad.settings import SanadSettings

    return SanadSession(SanadSettings.load())


def _build_client() -> "SanadClient":
    from kimi_cli.sanad.client import SanadClient
    from kimi_cli.sanad.settings import SanadSettings

    return SanadClient(SanadSettings.load())


def _resolve_token() -> tuple[str | None, int]:
    """Session token, or ``(None, EXIT_FAILURE)`` with the error already printed."""
    from kimi_cli.sanad.errors import SanadError

    session = _build_session()
    try:
        token = session.require_token()
    except SanadError as e:
        typer.echo(f"error: {e.message}", err=True)
        return None, EXIT_FAILURE
    finally:
        session.close()
    return token, EXIT_OK


def _collect_bundle_files(
    work_dir: Path, agent_path: Path, worker_path: Path, system_prompt_path: Path
) -> tuple[dict[str, str], str | None]:
    """Read agent.yaml + worker.yaml + the referenced system prompt as a files map.

    Keys are paths relative to ``work_dir`` (the shape the versions route
    expects); a file outside ``work_dir`` or unreadable is reported as a
    single error string rather than raised, so the caller can turn it into a
    clean exit-4 message.
    """
    files: dict[str, str] = {}
    for abs_path in (agent_path, worker_path, system_prompt_path):
        try:
            key = str(abs_path.relative_to(work_dir))
        except ValueError:
            return {}, f"{abs_path} is outside --work-dir {work_dir}"
        try:
            files[key] = abs_path.read_text(encoding="utf-8")
        except OSError as e:
            return {}, f"cannot read {abs_path}: {e}"
    return files, None


@cli.command()
def deploy(
    env: Annotated[str, typer.Option("--env")] = "dev",
    workspace: Annotated[str, typer.Option("--workspace")] = "default",
    agent_file: Annotated[Path, typer.Option("--agent-file")] = Path("agent.yaml"),
    worker_file: Annotated[Path, typer.Option("--worker-file")] = Path("worker.yaml"),
    work_dir: Annotated[Path, typer.Option("--work-dir")] = Path("."),
) -> None:
    """Validate the local bundle, then upsert/version/deploy it to the control plane.

    The agent name comes from agent.yaml's own ``agent.name`` field, not a CLI
    argument — deploy always ships the bundle it validates.
    """
    raise typer.Exit(_deploy(env, workspace, agent_file, worker_file, work_dir))


def _deploy(env: str, workspace: str, agent_file: Path, worker_file: Path, work_dir: Path) -> int:
    from kimi_cli.agentspec import load_agent_spec
    from kimi_cli.exception import AgentSpecError
    from kimi_cli.sanad.errors import SanadError
    from kimi_cli.worker import WorkerSpecError, load_worker_spec

    work_dir = work_dir.resolve()
    agent_path = (work_dir / agent_file).resolve()
    worker_path = (work_dir / worker_file).resolve()

    try:
        resolved = load_agent_spec(agent_path)
        load_worker_spec(worker_path)
    except (AgentSpecError, WorkerSpecError, FileNotFoundError, OSError) as e:
        typer.echo(f"error: {e}", err=True)
        return EXIT_BAD_INPUT

    files, bundle_error = _collect_bundle_files(
        work_dir, agent_path, worker_path, resolved.system_prompt_path
    )
    if bundle_error is not None:
        typer.echo(f"error: {bundle_error}", err=True)
        return EXIT_BAD_INPUT

    # Validation (and every filesystem read) happens above, before any client
    # is built or network call attempted — a broken bundle never touches the
    # control plane.
    token, code = _resolve_token()
    if token is None:
        return code

    client = _build_client()
    try:
        result = client.deploy_agent(
            token, name=resolved.name, files=files, env=env, workspace=workspace
        )
    except SanadError as e:
        typer.echo(f"error: {e.message}", err=True)
        return EXIT_FAILURE
    finally:
        client.close()

    typer.echo(result.model_dump_json(by_alias=True))
    return EXIT_OK


def _format_age(created_at: str, now: datetime) -> str:
    try:
        created = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
    except ValueError:
        return "?"
    if created.tzinfo is None:
        created = created.replace(tzinfo=UTC)
    seconds = max(0, int((now - created).total_seconds()))
    if seconds < 60:
        return f"{seconds}s"
    minutes = seconds // 60
    if minutes < 60:
        return f"{minutes}m"
    hours = minutes // 60
    if hours < 24:
        return f"{hours}h"
    return f"{hours // 24}d"


@cli.command()
def runs(
    agent: Annotated[str | None, typer.Option("--agent")] = None,
    env: Annotated[str | None, typer.Option("--env")] = None,
    limit: Annotated[int, typer.Option("--limit")] = 20,
    as_json: Annotated[bool, typer.Option("--json")] = False,
) -> None:
    """List recent runs as a compact table (id, status, cost, tokens, age)."""
    raise typer.Exit(_runs(agent, env, limit, as_json))


def _runs(agent: str | None, env: str | None, limit: int, as_json: bool) -> int:
    from kimi_cli.sanad.errors import SanadError

    token, code = _resolve_token()
    if token is None:
        return code

    client = _build_client()
    try:
        rows = client.list_runs(token, agent=agent, env=env, limit=limit)
    except SanadError as e:
        typer.echo(f"error: {e.message}", err=True)
        return EXIT_FAILURE
    finally:
        client.close()

    if as_json:
        typer.echo(json.dumps([r.model_dump(by_alias=True) for r in rows]))
        return EXIT_OK

    now = datetime.now(UTC)
    typer.echo(f"{'ID':<16} {'STATUS':<10} {'COST':>10} {'IN':>8} {'OUT':>8}  AGE")
    for r in rows:
        cost = f"${r.cost_usd_micros / 1_000_000:.4f}"
        typer.echo(
            f"{r.id:<16} {r.status:<10} {cost:>10} {r.tokens_in:>8} {r.tokens_out:>8}  "
            f"{_format_age(r.created_at, now)}"
        )
    return EXIT_OK


@cli.command()
def logs(
    run_id: Annotated[str, typer.Argument()],
    follow: Annotated[
        bool,
        typer.Option("--follow", help="Reserved for a future streaming mode; currently a no-op."),
    ] = False,
) -> None:
    """Print the trace URL for a finished run."""
    raise typer.Exit(_logs(run_id))


def _logs(run_id: str) -> int:
    from kimi_cli.sanad.errors import SanadError

    token, code = _resolve_token()
    if token is None:
        return code

    client = _build_client()
    try:
        url = client.get_run_trace_url(token, run_id)
    except SanadError as e:
        typer.echo(f"error: {e.message}", err=True)
        return EXIT_FAILURE
    finally:
        client.close()

    typer.echo(url)
    return EXIT_OK


def _set_status(name: str, env: str, status: str) -> int:
    from kimi_cli.sanad.errors import SanadError

    token, code = _resolve_token()
    if token is None:
        return code

    client = _build_client()
    try:
        client.set_deployment_status(token, agent=name, env=env, status=status)
    except SanadError as e:
        typer.echo(f"error: {e.message}", err=True)
        return EXIT_FAILURE
    finally:
        client.close()

    typer.echo(f"{name} ({env}): {status}")
    return EXIT_OK


@cli.command()
def pause(
    name: Annotated[str, typer.Argument()],
    env: Annotated[str, typer.Option("--env")] = "dev",
) -> None:
    """Pause the live deployment for NAME in --env."""
    raise typer.Exit(_set_status(name, env, "paused"))


@cli.command()
def resume(
    name: Annotated[str, typer.Argument()],
    env: Annotated[str, typer.Option("--env")] = "dev",
) -> None:
    """Resume the paused deployment for NAME in --env."""
    raise typer.Exit(_set_status(name, env, "active"))
