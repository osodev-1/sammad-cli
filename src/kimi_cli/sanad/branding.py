"""sanad brand palette and banner.

The shell welcome shows the "sanad" wordmark (a figlet logotype) in gold ink on
near-black; the leaning-figure pun from the app icon stays in the icon, not the
ASCII art. Kept here as data so the skin and the auth commands share one source.
"""

from __future__ import annotations

from rich.console import Console
from rich.text import Text

NAME = "sanad"
TAGLINE = "governed agent workspace"

# sanad is a downstream fork of Kimi Code CLI; keep the provenance visible.
UPSTREAM_NAME = "Kimi Code CLI"

# Palette (truecolor hex). Names mirror the design reference.
GOLD = "#cba36a"
SAND = "#e6cf9a"
RUST = "#c85f27"
INK = "#141210"
MUTED = "#8a7f6d"

# The shell welcome wordmark: the "sanad" logotype (a figlet rendering) in gold
# ink. The leaning-figure pun from the app icon reads as noise at ASCII scale, so
# the terminal uses the clean wordmark and the icon carries the figure. Rendered
# via Rich markup; wrapping each line keeps the ``\`` and backtick glyphs literal
# (no ``[`` appears in the art, so nothing is mistaken for a markup tag).
_WORDMARK = (
    "                       _\n"
    " ___ __ _ _ _  __ _ __| |\n"
    "(_-</ _` | ' \\/ _` / _` |\n"
    "/__/\\__,_|_||_\\__,_\\__,_|"
)
SHELL_LOGO = "\n".join(f"[{GOLD}]{_line}[/]" for _line in _WORDMARK.split("\n"))

WELCOME = f"Welcome to {NAME}!"


def banner_text() -> Text:
    """The one-line brand banner as a Rich renderable."""
    text = Text()
    text.append("◆", style=f"bold {RUST}")
    text.append(f" {NAME}", style=f"bold {SAND}")
    text.append("  ")
    text.append(TAGLINE, style=MUTED)
    return text


def print_banner(console: Console | None = None) -> None:
    (console or Console()).print(banner_text())


def about_text(version: str, upstream_version: str | None = None) -> Text:
    """Multi-line 'about' block: sanad identity + upstream attribution."""
    text = Text()
    text.append(f"{NAME} ", style=f"bold {SAND}")
    text.append(f"v{version}\n", style=GOLD)
    text.append(TAGLINE + "\n", style=MUTED)
    upstream = f"{UPSTREAM_NAME}"
    if upstream_version:
        upstream += f" v{upstream_version}"
    text.append(f"forked from {upstream}, Apache-2.0", style=MUTED)
    return text
