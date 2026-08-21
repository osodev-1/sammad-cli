"""Durable per-conversation coder journal — the write side (P3 Task 1).

agentd owns this journal (not the CLI's own ``wire.jsonl``): it's a delivery
buffer that lets ``follow(turnId)``/``GET /turn`` survive an agentd restart,
idle-stop, or deploy — NOT a history store. One ``CoderJournal`` per
conversation, rooted at ``<user_dir>/agentd/coder/<cid>``:

- ``turns/<turnId>.ndjson`` — one turn's journal items, one JSON object per
  line, in the exact shape the frontend already consumes over ``/follow``.
- ``turns.json`` — the ordered index of known turns (``{turnId, status,
  sendId, startedAt, lastSeq}``) a fresh runner reads on reconstruction
  (P3 Task 2; this module only writes/reads raw data, never reconstructs
  ``TurnState``s).

Every public method here is best-effort: a durable-write failure must never
break a live turn, so every method logs and swallows rather than raising.
"""

from __future__ import annotations

import contextlib
import json
import os
import tempfile
from pathlib import Path
from typing import Any

from loguru import logger


class CoderJournal:
    """Append-only per-turn NDJSON files + an atomically-replaced index."""

    def __init__(self, dir_path: Path, *, turns_keep: int, max_bytes: int) -> None:
        self.dir_path = Path(dir_path)
        self.turns_dir = self.dir_path / "turns"
        self.turns_keep = turns_keep
        self.max_bytes = max_bytes
        # Per-turn running byte count and overflow state — in-memory only;
        # a fresh instance (e.g. after a restart) recomputes lazily from the
        # file already on disk the first time it appends to that turn.
        self._sizes: dict[str, int] = {}
        self._overflowed: set[str] = set()
        try:
            self.turns_dir.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            logger.warning("coder journal: could not create {}: {}", self.turns_dir, exc)

    def _turn_path(self, turn_id: str) -> Path:
        return self.turns_dir / f"{turn_id}.ndjson"

    # -- write side ------------------------------------------------------

    def append(self, turn_id: str, item: dict[str, Any]) -> None:
        """Append one journal item as a JSON line. Never raises — a journal
        write must never break a live turn."""
        if turn_id in self._overflowed:
            return
        try:
            path = self._turn_path(turn_id)
            line = (json.dumps(item) + "\n").encode("utf-8")
            size = self._sizes.get(turn_id)
            if size is None:
                size = path.stat().st_size if path.exists() else 0
            with path.open("ab") as f:
                f.write(line)
            size += len(line)
            self._sizes[turn_id] = size
            if size > self.max_bytes:
                self._overflowed.add(turn_id)
                overflow = (
                    json.dumps(
                        {
                            "kind": "error",
                            "code": "journal_overflow",
                            "message": (
                                f"turn journal exceeded {self.max_bytes} bytes; "
                                "further items are not persisted"
                            ),
                        }
                    )
                    + "\n"
                ).encode("utf-8")
                with path.open("ab") as f:
                    f.write(overflow)
        except Exception as exc:  # broad: durability must never break a live turn
            logger.warning("coder journal: append failed for turn {}: {}", turn_id, exc)

    def write_index(self, turns: list[dict[str, Any]]) -> None:
        """Atomically (tmp + os.replace) overwrite turns.json with the given
        ordered list. Never raises."""
        try:
            self.dir_path.mkdir(parents=True, exist_ok=True)
            payload = json.dumps(turns)
            fd, tmp = tempfile.mkstemp(dir=str(self.dir_path), prefix=".turns-")
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as f:
                    f.write(payload)
                os.replace(tmp, self.dir_path / "turns.json")
            except BaseException:
                with contextlib.suppress(OSError):
                    os.unlink(tmp)
                raise
        except Exception as exc:  # broad: durability must never break a live turn
            logger.warning("coder journal: write_index failed for {}: {}", self.dir_path, exc)

    def fsync_turn(self, turn_id: str) -> None:
        """Best-effort fsync of one turn's file at turn end (not per-item —
        EFS latency). Never raises."""
        try:
            path = self._turn_path(turn_id)
            if not path.exists():
                return
            fd = os.open(str(path), os.O_RDONLY)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
        except OSError as exc:
            logger.debug("coder journal: fsync failed for turn {}: {}", turn_id, exc)

    def prune(self, keep_turn_ids: list[str]) -> None:
        """Delete turns/*.ndjson not in keep_turn_ids, and drop the
        matching `_sizes`/`_overflowed` bookkeeping so it doesn't grow
        unbounded over a long-lived journal (P3 Task 2 minor fold-in).
        Never raises."""
        keep = set(keep_turn_ids)
        try:
            if self.turns_dir.is_dir():
                for path in self.turns_dir.glob("*.ndjson"):
                    if path.stem not in keep:
                        with contextlib.suppress(OSError):
                            path.unlink()
        except Exception as exc:  # broad: durability must never break a live turn
            logger.warning("coder journal: prune failed for {}: {}", self.turns_dir, exc)
        for turn_id in list(self._sizes):
            if turn_id not in keep:
                self._sizes.pop(turn_id, None)
        self._overflowed &= keep

    # -- read side (raw data only — reconstruction is P3 Task 2) --------

    def load(self) -> tuple[list[dict[str, Any]], dict[str, list[dict[str, Any]]]]:
        """Read turns.json + each referenced turn file. Missing/corrupt
        index -> ([], {}). A corrupt turn file is skipped (logged), not
        raised."""
        index_path = self.dir_path / "turns.json"
        try:
            raw = index_path.read_text(encoding="utf-8")
            index = json.loads(raw)
            if not isinstance(index, list):
                raise ValueError("turns.json root is not a list")
        except (OSError, ValueError) as exc:
            if index_path.exists():
                logger.warning("coder journal: corrupt index at {}: {}", index_path, exc)
            return [], {}

        items_by_turn: dict[str, list[dict[str, Any]]] = {}
        for entry in index:
            turn_id = entry.get("turnId") if isinstance(entry, dict) else None
            if not isinstance(turn_id, str):
                continue
            items = self._load_turn_file(turn_id)
            if items is not None:
                items_by_turn[turn_id] = items
        return index, items_by_turn

    def _load_turn_file(self, turn_id: str) -> list[dict[str, Any]] | None:
        path = self._turn_path(turn_id)
        try:
            items: list[dict[str, Any]] = []
            with path.open("r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if line:
                        items.append(json.loads(line))
            return items
        except FileNotFoundError:
            return None
        except OSError as exc:
            logger.warning("coder journal: could not read turn file {}: {}", path, exc)
            return None
        except ValueError as exc:
            logger.warning("coder journal: corrupt turn file {}: {}", path, exc)
            return None
