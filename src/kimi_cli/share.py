from __future__ import annotations

import os
from pathlib import Path

from kimi_cli.constant import NAME


def get_share_dir() -> Path:
    """Get the share directory path.

    Defaults to ``~/.<NAME>`` (``~/.sanad``) so a governed session never writes to
    ``~/.kimi``. ``KIMI_SHARE_DIR`` still overrides it — the env var keeps its
    upstream name so the inherited test suite keeps working.
    """
    if share_dir := os.getenv("KIMI_SHARE_DIR"):
        share_dir = Path(share_dir)
    else:
        share_dir = Path.home() / f".{NAME}"
    share_dir.mkdir(parents=True, exist_ok=True)
    return share_dir
