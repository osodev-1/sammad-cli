"""Tests for the sanad skin: brand constants, logo, and version output."""

from __future__ import annotations

from rich.text import Text
from typer.testing import CliRunner

from kimi_cli import constant
from kimi_cli.sanad import branding
from kimi_cli.sanad import cli as cli_mod

runner = CliRunner()


def test_product_name_is_rebranded_with_upstream_attribution():
    assert constant.NAME == "sanad"
    assert constant.UPSTREAM_NAME == "Kimi Code CLI"
    assert branding.NAME == "sanad"


def test_shell_logo_is_valid_markup_and_aligned():
    # Renders without raising; a 3-row gem with equal-width rows.
    text = Text.from_markup(branding.SHELL_LOGO)
    rows = text.plain.split("\n")
    assert len(rows) == 3
    assert len({len(r) for r in rows}) == 1  # all rows same display width
    assert "◆" in text.plain  # the rust diamond accent
    assert branding.WELCOME == "Welcome to sanad!"


def test_about_text_names_both_sanad_and_upstream():
    text = branding.about_text("1.49.0", upstream_version="1.49.0")
    plain = text.plain
    assert "sanad" in plain
    assert "Kimi Code CLI" in plain
    assert "Apache-2.0" in plain


def test_version_flag_prints_provenance():
    result = runner.invoke(cli_mod.sanad_app, ["--version"])
    assert result.exit_code == 0, result.output
    assert "sanad" in result.output
    assert "Kimi Code CLI" in result.output


def test_about_command_prints_banner_and_provenance():
    result = runner.invoke(cli_mod.sanad_app, ["about"])
    assert result.exit_code == 0, result.output
    assert "sanad" in result.output
    assert "Kimi Code CLI" in result.output
