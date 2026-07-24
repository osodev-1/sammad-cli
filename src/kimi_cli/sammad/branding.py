"""sammad brand palette and banner.

Carried from the backend repo's CLI design reference: a cross-stitch / pixel
mark in gold and sand on near-black ink, with a rust-orange diamond accent.
Kept here as data so the skin (phase 5) and the auth commands share one source.
"""

from __future__ import annotations

from rich.console import Console
from rich.text import Text

NAME = "sammad"
TAGLINE = "governed agent workspace"

# sammad is a downstream fork of Kimi Code CLI; keep the provenance visible.
UPSTREAM_NAME = "Kimi Code CLI"

# Palette (truecolor hex). Names mirror the design reference.
GOLD = "#cba36a"
SAND = "#e6cf9a"
RUST = "#c85f27"
INK = "#141210"
MUTED = "#8a7f6d"

# The cross-stitch mark for the shell welcome: a gold gem/diamond echoing the
# sammad emblem's central rhombus, with the rust diamond as its heart. Uses the
# quadrant block glyphs that render cleanly in the target terminals; each of the
# three rows is the same display width so it stays aligned. ``Text.from_markup``
# renders this.
SHELL_LOGO = (
    f"[{GOLD}] ▟█▙ [/]\n"
    f"[{GOLD}]██[/][{RUST}]◆[/][{GOLD}]██[/]\n"
    f"[{GOLD}] ▜█▛ [/]"
)

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
    """Multi-line 'about' block: sammad identity + upstream attribution."""
    text = Text()
    text.append(f"{NAME} ", style=f"bold {SAND}")
    text.append(f"v{version}\n", style=GOLD)
    text.append(TAGLINE + "\n", style=MUTED)
    upstream = f"{UPSTREAM_NAME}"
    if upstream_version:
        upstream += f" v{upstream_version}"
    text.append(f"forked from {upstream}, Apache-2.0", style=MUTED)
    return text
