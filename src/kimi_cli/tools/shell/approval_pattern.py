"""Derive a per-command-head approval action string for shell tool calls.

The Shell tool only has the raw command string available (it runs through a
shell, so there is no argv). To avoid every distinct command sharing a single
coarse "run command" approval bucket, this extracts the leading command
"head(s)" — e.g. ``git`` from ``git status`` — so the approval action reflects
what is actually being run, while still degrading gracefully to the legacy
bare action when no head can be derived.

Two hardening rules keep the derived action trustworthy rather than merely
informative:

- Wrapper prefixes (``sudo``, ``env``, ...) are transparent: the head comes
  from the wrapped command, not the wrapper, so ``sudo git push`` is bucketed
  under ``git`` rather than a blanket-approvable ``sudo``.
- A head containing characters that could forge the formatted action string
  (comma, parens, whitespace) is treated as suspicious and the whole request
  falls back to the bare, coarse action instead of trusting the fragment.
"""

from __future__ import annotations

import re
import shlex

_SEPARATORS = ("&&", "||", "|", ";", "&")
_ENV_ASSIGNMENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")
_SUSPICIOUS_HEAD_RE = re.compile(r"[,()\s]")

# Commands that merely wrap another command. The approval action should be
# keyed on what they run, never on the wrapper itself — otherwise approving
# `sudo git push` once would session-cache a bare `sudo` bucket that covers
# any future `sudo <anything>`.
_WRAPPER_PREFIXES = frozenset({"sudo", "env", "nohup", "nice", "time", "command", "exec"})


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


def _is_suspicious_head(head: str) -> bool:
    """True when *head* contains characters that could forge the formatted action."""
    return bool(_SUSPICIOUS_HEAD_RE.search(head))


def _segment_head(segment: str) -> str | None:
    try:
        tokens = shlex.split(segment)
    except ValueError:
        tokens = segment.split()

    idx = 0
    while idx < len(tokens):
        token = tokens[idx]
        if _is_env_assignment(token):
            # Also covers "skip subsequent VAR=val tokens after env": once a
            # wrapper is consumed below, this same check runs again on the
            # next token before any wrapper check does.
            idx += 1
            continue
        stripped = token.rsplit("/", 1)[-1]
        if stripped in _WRAPPER_PREFIXES:
            idx += 1
            continue
        return stripped or None

    return None


def action_for(command: str, prefix: str = "run command") -> str:
    """Return an approval action naming the command's head(s), e.g. ``run command (git)``.

    Falls back to the bare *prefix* (legacy behavior) when no head can be
    derived (e.g. an empty command, or a command that is only wrapper
    prefixes) or when any derived head looks like it could forge the
    formatted action string.
    """
    heads: list[str] = []
    for segment in _split_unquoted(command):
        head = _segment_head(segment)
        if head is not None and head not in heads:
            heads.append(head)

    if not heads or any(_is_suspicious_head(head) for head in heads):
        return prefix
    return f"{prefix} ({', '.join(heads)})"
