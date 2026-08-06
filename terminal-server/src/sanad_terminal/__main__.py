"""Console entry: validate settings, then serve."""

from __future__ import annotations

import sys

import uvicorn
from loguru import logger

from sanad_terminal.settings import SettingsError, TerminalSettings


def main() -> None:
    try:
        settings = TerminalSettings.load()
    except SettingsError as exc:
        logger.error("refusing to start: {}", exc)
        sys.exit(1)

    # Single worker: the session registry and PTYs are in-process state.
    uvicorn.run(
        "sanad_terminal.app:create_app",
        factory=True,
        host="0.0.0.0",
        port=settings.port,
        workers=1,
    )


if __name__ == "__main__":
    main()
