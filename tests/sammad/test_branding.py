"""Tests for the sammad skin: brand constants, logo, and version output."""

from __future__ import annotations

from rich.text import Text
from typer.testing import CliRunner

from kimi_cli import constant
from kimi_cli.sammad import branding
from kimi_cli.sammad import cli as cli_mod

runner = CliRunner()


def test_product_name_is_rebranded_with_upstream_attribution():
    assert constant.NAME == "sammad"
    assert constant.UPSTREAM_NAME == "Kimi Code CLI"
    assert branding.NAME == "sammad"


def test_shell_logo_is_valid_markup_and_two_lines():
    # Renders without raising and keeps upstream's two-row footprint.
    text = Text.from_markup(branding.SHELL_LOGO)
    assert branding.SHELL_LOGO.count("\n") == 1
    assert "◆" in text.plain  # the rust diamond accent
    assert branding.WELCOME == "Welcome to sammad!"


def test_about_text_names_both_sammad_and_upstream():
    text = branding.about_text("1.49.0", upstream_version="1.49.0")
    plain = text.plain
    assert "sammad" in plain
    assert "Kimi Code CLI" in plain
    assert "Apache-2.0" in plain


def test_version_flag_prints_provenance():
    result = runner.invoke(cli_mod.sammad_app, ["--version"])
    assert result.exit_code == 0, result.output
    assert "sammad" in result.output
    assert "Kimi Code CLI" in result.output


def test_about_command_prints_banner_and_provenance():
    result = runner.invoke(cli_mod.sammad_app, ["about"])
    assert result.exit_code == 0, result.output
    assert "sammad" in result.output
    assert "Kimi Code CLI" in result.output
