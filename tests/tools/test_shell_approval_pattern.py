"""Tests for shell approval pattern head extraction."""

from __future__ import annotations

import platform

import pytest

from kimi_cli.tools.shell.approval_pattern import action_for

pytestmark = pytest.mark.skipif(
    platform.system() == "Windows", reason="Shell approval pattern tests run only on non-Windows."
)


def test_single_head():
    assert action_for("git status") == "run command (git)"


def test_path_and_env_prefixes_stripped():
    assert action_for("FOO=1 /usr/bin/git log") == "run command (git)"


def test_pipeline_collects_heads_in_order():
    assert action_for("git log | grep fix && sed -i s/a/b/ f.txt") == "run command (git, grep, sed)"


def test_duplicate_heads_dedupe():
    assert action_for("git add . && git commit") == "run command (git)"


def test_unparseable_falls_back_to_legacy():
    assert action_for("") == "run command"
    assert action_for("   ") == "run command"


def test_background_prefix():
    assert action_for("npm run dev", prefix="run background command") == "run background command (npm)"


def test_quoted_separators_are_not_boundaries():
    assert action_for("echo 'a && b'") == "run command (echo)"


# --- head sanitization: forged heads must not masquerade as a genuine pipeline ---


def test_forged_head_with_commas_falls_back_to_legacy():
    assert action_for('"git, sed" foo') == "run command"


def test_genuine_two_command_pipeline_still_formatted():
    assert action_for("git log | sed -n 1p") == "run command (git, sed)"


# --- wrapper prefixes are transparent: the wrapped command is the head ---


def test_sudo_wrapper_is_skipped():
    assert action_for("sudo git status") == "run command (git)"


def test_env_wrapper_skips_var_assignments():
    assert action_for("env FOO=1 npm ci") == "run command (npm)"


def test_bare_wrapper_falls_back_to_legacy():
    assert action_for("sudo") == "run command"
