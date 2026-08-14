"""Derive a per-command-head approval action string for shell tool calls.

The Shell tool only has the raw command string available (it runs through a
shell, so there is no argv). To avoid every distinct command sharing a single
coarse "run command" approval bucket, this extracts the leading command
"head(s)" — e.g. ``git`` from ``git status`` — so the approval action reflects
what is actually being run, while still degrading gracefully to the legacy
bare action when no head can be derived.
"""

from __future__ import annotations

import re
import shlex

_SEPARATORS = ("&&", "||", "|", ";", "&")
_ENV_ASSIGNMENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")


def _split_unquoted(command: str) -> list[str]:
    """Split *command* into segments on unquoted ``|``, ``&&``, ``||``, ``;``, ``&``."""
    segments: list[str] = []
    current: list[str] = []
    quote: str | None = None
    i = 0
    n = len(command)
    while i < n:
        ch = command[i]
        if quote is not None:
            current.append(ch)
            if ch == quote:
                quote = None
            i += 1
            continue
        if ch in ("'", '"'):
            quote = ch
            current.append(ch)
            i += 1
            continue
        matched_sep = next((sep for sep in _SEPARATORS if command.startswith(sep, i)), None)
        if matched_sep is not None:
            segments.append("".join(current))
            current = []
            i += len(matched_sep)
            continue
        current.append(ch)
        i += 1
    segments.append("".join(current))
    return segments


def _is_env_assignment(token: str) -> bool:
    return bool(_ENV_ASSIGNMENT_RE.match(token))


def _segment_head(segment: str) -> str | None:
    try:
        tokens = shlex.split(segment)
    except ValueError:
        tokens = segment.split()

    idx = 0
    while idx < len(tokens) and _is_env_assignment(tokens[idx]):
        idx += 1
    if idx >= len(tokens):
        return None

    head = tokens[idx].rsplit("/", 1)[-1]
    return head or None


def action_for(command: str, prefix: str = "run command") -> str:
    """Return an approval action naming the command's head(s), e.g. ``run command (git)``.

    Falls back to the bare *prefix* (legacy behavior) when no head can be
    derived, such as an empty or whitespace-only command.
    """
    heads: list[str] = []
    for segment in _split_unquoted(command):
        head = _segment_head(segment)
        if head is not None and head not in heads:
            heads.append(head)

    if not heads:
        return prefix
    return f"{prefix} ({', '.join(heads)})"
