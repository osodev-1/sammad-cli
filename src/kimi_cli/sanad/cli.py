"""sanad CLI commands: SSO login/logout/whoami/doctor and a governed ``run``.

These are net-new and self-contained so upstream rebases stay cheap. Command
bodies stay thin — all lifecycle logic lives in :mod:`kimi_cli.sanad.session`.
The console script ``sanad`` dispatches here; ``sanad run`` mints a runtime
token, writes the gateway provider config, keeps it alive, and launches the
kimi agent against it.
"""

from __future__ import annotations

import os
import webbrowser
from collections.abc import MutableMapping, Sequence
from typing import Annotated

import typer
from rich.console import Console

from kimi_cli.sanad.branding import (
    GOLD,
    MUTED,
    RUST,
    SAND,
    about_text,
    print_banner,
)
from kimi_cli.sanad.errors import SanadError
from kimi_cli.sanad.models import DeviceStart
from kimi_cli.sanad.session import SanadSession
from kimi_cli.sanad.settings import SanadSettings


def _version_callback(value: bool) -> None:
    if value:
        from kimi_cli.constant import get_version

        Console().print(about_text(get_version(), upstream_version=get_version()))
        raise typer.Exit()


sanad_app = typer.Typer(
    add_completion=False,
    context_settings={"help_option_names": ["-h", "--help"]},
    help="sanad — governed, SSO-first agent workspace.",
    no_args_is_help=True,
)


@sanad_app.callback()
def _root(
    version: Annotated[
        bool,
        typer.Option(
            "--version",
            "-V",
            help="Show version and provenance, then exit.",
            callback=_version_callback,
            is_eager=True,
        ),
    ] = False,
) -> None:
    """sanad — governed, SSO-first agent workspace."""


def _build_session() -> SanadSession:
    """Seam for tests: return a session bound to the configured control plane."""
    return SanadSession(SanadSettings.load())


# Governance defaults applied to the agent's environment on ``sanad run``.
# Upstream's telemetry sink egresses to a Moonshot endpoint and its auto-update
# checks/pulls upstream kimi-cli releases — both are inappropriate for a
# governed enterprise fork. We disable them by default (fail-closed on data
# egress) but use setdefault so an operator who deliberately sets either value
# still wins.
_FORK_ENV_DEFAULTS = {
    "KIMI_DISABLE_TELEMETRY": "1",
    "KIMI_CLI_NO_AUTO_UPDATE": "1",
}


def _apply_governed_env(env: MutableMapping[str, str]) -> None:
    for key, value in _FORK_ENV_DEFAULTS.items():
        env.setdefault(key, value)


def _fail(console: Console, exc: SanadError) -> None:
    console.print(f"✗ {exc.message}", style=f"bold {RUST}")
    raise typer.Exit(code=1)


def _launch_workspace(console: Console, extra_args: Sequence[str] = ()) -> None:
    """Mint a runtime token and hand the terminal to the governed agent.

    Shared by ``sanad run`` and the post-login handoff so signing in flows
    straight into a working session without a second command.
    """
    from kimi_cli.config import load_config

    # Governance posture: no telemetry to Moonshot, no auto-update from upstream.
    _apply_governed_env(os.environ)

    session = _build_session()
    try:
        session.require_token()  # fail fast before touching on-disk config
        config = load_config()
        mint = session.configure_run(config)
    except SanadError as exc:
        session.close()
        _fail(console, exc)
        return

    renewer = session.new_renewer(mint)
    renewer.start()
    try:
        from kimi_cli.cli import cli

        cli(args=list(extra_args), prog_name="sanad", standalone_mode=True)
    finally:
        renewer.stop()
        session.close()


@sanad_app.command()
def login(
    no_run: Annotated[
        bool,
        typer.Option(
            "--no-run",
            help="Sign in only; skip launching the workspace afterwards.",
        ),
    ] = False,
) -> None:
    """Sign in with your organization identity, then launch the workspace."""
    console = Console()
    print_banner(console)
    session = _build_session()

    def _prompt(start: DeviceStart) -> None:
        target = start.verification_uri_complete or start.verification_uri
        # Best effort: surface the approval page in the user's browser. Always
        # print the URL + code too — the browser may be remote (SSH), headless,
        # or opened under the wrong profile.
        try:
            opened = webbrowser.open(target)
        except Exception:
            opened = False
        console.print()
        if opened:
            console.print("Opening your browser to approve the sign-in.")
            console.print("If nothing opened, visit:")
        else:
            console.print("To sign in, open the following URL and confirm the code:")
        console.print(f"  {target}", style=f"bold {SAND}")
        console.print("  code: ", style=MUTED, end="")
        console.print(start.user_code, style=f"bold {GOLD}")
        console.print()

    try:
        with console.status("Waiting for approval…", spinner="dots"):
            result = session.login(on_prompt=_prompt)
    except SanadError as exc:
        _fail(console, exc)
    finally:
        session.close()

    user = result.user
    org = result.organization
    who = user.email if user else "your account"
    where = f" · {org.name}" if org else ""
    console.print(f"✓ Signed in as {who}{where}", style="bold green")

    if no_run:
        return
    console.print()
    _launch_workspace(console)


@sanad_app.command()
def about() -> None:
    """Show sanad's version and upstream provenance."""
    from kimi_cli.constant import get_version

    console = Console()
    print_banner(console)
    console.print()
    console.print(about_text(get_version(), upstream_version=get_version()))


@sanad_app.command()
def whoami() -> None:
    """Show the signed-in identity, organization, and role."""
    console = Console()
    session = _build_session()
    try:
        me = session.whoami()
    except SanadError as exc:
        _fail(console, exc)
    finally:
        session.close()

    console.print("user:  ", style=MUTED, end="")
    console.print(me.user_id, style=SAND)
    console.print("org:   ", style=MUTED, end="")
    console.print(me.organization_id, style=SAND)
    console.print("role:  ", style=MUTED, end="")
    console.print(me.role, style=GOLD)


@sanad_app.command()
def usage() -> None:
    """Show this period's usage against your plan's quota."""
    console = Console()
    session = _build_session()
    try:
        summary = session.usage()
    except SanadError as exc:
        _fail(console, exc)
    finally:
        session.close()

    console.print("used:  ", style=MUTED, end="")
    console.print(f"{summary.used} / {summary.limit} requests", style=SAND)
    if summary.period_end:
        console.print("resets:", style=MUTED, end="")
        console.print(f" {summary.period_end}", style=SAND)
    for m in summary.by_model:
        console.print(f"  {m.alias:<15} ", style=MUTED, end="")
        console.print(f"{m.requests} req", style=SAND)


@sanad_app.command()
def logout() -> None:
    """Revoke the current session and clear the local credential."""
    console = Console()
    session = _build_session()
    try:
        session.logout()
    except SanadError as exc:
        _fail(console, exc)
    finally:
        session.close()
    console.print("✓ Signed out.", style="bold green")


@sanad_app.command()
def doctor() -> None:
    """Diagnose the sanad setup: keychain, control plane, and session."""
    console = Console()
    settings = SanadSettings.load()
    session = _build_session()
    ok = True

    console.print("control plane: ", style=MUTED, end="")
    console.print(settings.api_base_url, style=SAND)

    # Keychain reachability + whether a token is stored.
    try:
        token = session.stored_token()
        console.print("✓ keychain reachable", style="green")
    except SanadError as exc:
        ok = False
        token = None
        console.print(f"✗ keychain: {exc.message}", style=RUST)

    if not token:
        console.print("• not signed in — run `sanad login`", style=MUTED)
        session.close()
        if not ok:
            raise typer.Exit(code=1)
        return

    # Session validity against the control plane.
    try:
        me = session.whoami()
        console.print(f"✓ session valid ({me.role})", style="green")
    except SanadError as exc:
        ok = False
        console.print(f"✗ session: {exc.message}", style=RUST)
    finally:
        session.close()

    if not ok:
        raise typer.Exit(code=1)


@sanad_app.command(
    context_settings={"allow_extra_args": True, "ignore_unknown_options": True},
)
def run(ctx: typer.Context) -> None:
    """Launch the governed agent: mint a runtime token, then start the agent.

    Extra arguments after ``run`` are passed straight through to the underlying
    agent (e.g. ``sanad run -p "fix the build"``).
    """
    _launch_workspace(Console(), ctx.args)


def _blueprint_app() -> "typer.Typer":
    # Imported lazily so `sanad run` startup never pays for the blueprint deps.
    from kimi_cli.cli.blueprint import cli as blueprint_cli

    return blueprint_cli


sanad_app.add_typer(
    _blueprint_app(),
    name="blueprint",
    help="Validate and inspect the .sanad blueprint.",
)


def main() -> None:
    sanad_app()


if __name__ == "__main__":
    main()
