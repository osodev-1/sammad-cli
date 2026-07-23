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

# Palette (truecolor hex). Names mirror the design reference.
GOLD = "#cba36a"
SAND = "#e6cf9a"
RUST = "#c85f27"
INK = "#141210"
MUTED = "#8a7f6d"


def banner_text() -> Text:
    """The one-line brand banner as a Rich renderable."""
    text = Text()
    text.append("◆", style=f"bold {RUST}")
    text.append(" sammad", style=f"bold {SAND}")
    text.append("  ")
    text.append(TAGLINE, style=MUTED)
    return text


def print_banner(console: Console | None = None) -> None:
    (console or Console()).print(banner_text())
