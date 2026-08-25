"""Shared per-workspace-root lock (P5 Task 3).

One `asyncio.Lock` per workspace root, so any route module that mutates the
SAME workspace tree serializes against every other — not just against its
own kind. Originally private to `routes_blueprint.py` (apply/rollback/trust
review); extracted here so `routes_coder.py`'s revert can share the exact
same lock instance per root, and a revert can never interleave with a
blueprint apply/rollback (or vice versa) on the same workspace.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

# One lock per workspace root — writes serialize; reads are lock-free.
_locks: dict[str, asyncio.Lock] = {}


def lock_for(root: Path) -> asyncio.Lock:
    key = str(root)
    if key not in _locks:
        _locks[key] = asyncio.Lock()
    return _locks[key]
