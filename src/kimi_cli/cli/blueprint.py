"""`sanad blueprint` — validate and inspect a repository's .sanad blueprint.

The same validation the workspace runs, available in CLI and CI (PRD
VA-010/VA-011). Exit code is non-zero when there is any blocking diagnostic,
so it drops straight into pre-commit hooks and CI gates.
"""

from __future__ import annotations

import json as _json
import sys
from pathlib import Path
from typing import Annotated

import typer

cli = typer.Typer(
    no_args_is_help=True,
    add_completion=False,
    help="Validate and inspect the .sanad blueprint.",
    context_settings={"help_option_names": ["-h", "--help"]},
)


def _resolve_sanad_dir(path: Path) -> Path:
    """Accept either a repo root (…/.sanad appended) or the .sanad dir itself."""
    p = path.resolve()
    if p.name == ".sanad":
        return p
    return p / ".sanad"


@cli.command()
def validate(
    path: Annotated[
        Path,
        typer.Argument(help="Repository root or a .sanad directory."),
    ] = Path("."),
    json_output: Annotated[
        bool,
        typer.Option("--json", help="Emit diagnostics as JSON."),
    ] = False,
) -> None:
    """Validate the blueprint; exit non-zero on any blocking diagnostic."""
    from sanad_blueprint.validate import validate_blueprint

    sanad_dir = _resolve_sanad_dir(path)
    if not sanad_dir.is_dir():
        typer.echo(f"No .sanad directory found at {sanad_dir}", err=True)
        raise typer.Exit(2)

    report = validate_blueprint(sanad_dir)

    if json_output:
        typer.echo(
            _json.dumps(
                {
                    "ok": report.ok,
                    "diagnostics": [d.model_dump() for d in report.diagnostics],
                },
                ensure_ascii=False,
            )
        )
        raise typer.Exit(0 if report.ok else 1)

    if not report.diagnostics:
        typer.echo("Blueprint is valid — no diagnostics.")
        raise typer.Exit(0)

    for d in report.diagnostics:
        anchor = d.resource_id or d.path or "?"
        stream = sys.stderr if d.severity.value == "blocking" else sys.stdout
        typer.echo(f"[{d.severity.value}] {anchor}: {d.message} ({d.code})", file=stream)

    blocking = len(report.blocking)
    warnings = len(report.warnings)
    typer.echo(f"\n{blocking} blocking, {warnings} warning(s).")
    raise typer.Exit(0 if report.ok else 1)


@cli.command()
def graph(
    path: Annotated[Path, typer.Argument(help="Repository root or a .sanad directory.")] = Path("."),
) -> None:
    """Print the compiled blueprint graph as JSON."""
    from sanad_blueprint.graph import compile_graph
    from sanad_blueprint.indexer import index_blueprint

    sanad_dir = _resolve_sanad_dir(path)
    if not sanad_dir.is_dir():
        typer.echo(f"No .sanad directory found at {sanad_dir}", err=True)
        raise typer.Exit(2)
    compiled = compile_graph(index_blueprint(sanad_dir))
    typer.echo(_json.dumps(compiled.to_dict(), ensure_ascii=False, indent=2))
