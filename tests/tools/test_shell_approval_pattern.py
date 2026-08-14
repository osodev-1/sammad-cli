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
