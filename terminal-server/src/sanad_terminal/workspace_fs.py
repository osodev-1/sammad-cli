"""Path-safe filesystem operations rooted in a user's workspace.

This is the security core of the workspace API. Every operation resolves the
client-supplied relative path with `resolve_safe`, which rejects absolute
paths and `..` segments up front and then containment-checks the fully
resolved (symlink-followed) candidate against the resolved root — a symlink
pointing outside the workspace lands outside and fails the check. Hard-link
escapes are undetectable by path and are accepted under dogfood same-UID
(documented in the plan).
"""

from __future__ import annotations

import contextlib
import os
import shutil
import tarfile
import tempfile
import zipfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import BinaryIO, Literal

# Directories that are never listed, snapshotted, searched, or archived.
SKIP_DIRS = {".git", "node_modules", "__pycache__", ".venv", ".uv-cache"}

SNAPSHOT_MAX_ENTRIES = 5000
SEARCH_MAX_RESULTS = 200


class PathViolation(Exception):
    """Client-supplied path escapes (or tries to escape) the workspace."""


class NotFound(Exception):
    pass


class AlreadyExists(Exception):
    pass


class UnsupportedArchive(Exception):
    """The file is not a zip or tar archive we can list."""


@dataclass(frozen=True, slots=True)
class Entry:
    name: str
    path: str  # workspace-relative POSIX path
    kind: Literal["dir", "file"]
    size: int
    mtime: float


def resolve_safe(root: Path, rel: str) -> Path:
    """Resolve `rel` under `root`, guaranteeing containment.

    `rel` of "" or "." names the root itself.
    """
    pure = PurePosixPath(rel)
    if pure.is_absolute() or rel.startswith("\\"):
        raise PathViolation(f"absolute paths are not allowed: {rel!r}")
    if any(part == ".." for part in pure.parts):
        raise PathViolation(f"path traversal is not allowed: {rel!r}")

    root_resolved = root.resolve()
    candidate = (root_resolved / pure).resolve()
    if candidate != root_resolved and not candidate.is_relative_to(root_resolved):
        raise PathViolation(f"path escapes the workspace: {rel!r}")
    return candidate


def _entry(root: Path, path: Path) -> Entry:
    stat = path.lstat()
    return Entry(
        name=path.name,
        path=path.relative_to(root).as_posix(),
        kind="dir" if path.is_dir() and not path.is_symlink() else "file",
        size=0 if path.is_dir() else stat.st_size,
        mtime=stat.st_mtime,
    )


def _sorted_entries(entries: list[Entry]) -> list[Entry]:
    return sorted(entries, key=lambda e: (e.kind != "dir", e.name.lower()))


def list_dir(root: Path, rel: str) -> list[Entry]:
    target = resolve_safe(root, rel)
    if not target.is_dir():
        raise NotFound(rel)
    entries = [
        _entry(root.resolve(), child) for child in target.iterdir() if child.name not in SKIP_DIRS
    ]
    return _sorted_entries(entries)


def snapshot(root: Path, *, max_entries: int = SNAPSHOT_MAX_ENTRIES) -> tuple[list[Entry], bool]:
    """Bounded recursive listing. Returns (entries, truncated)."""
    root_resolved = root.resolve()
    entries: list[Entry] = []
    truncated = False
    for dirpath, dirnames, filenames in os.walk(root_resolved):
        dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS)
        base = Path(dirpath)
        for name in sorted(dirnames) + sorted(filenames):
            if len(entries) >= max_entries:
                truncated = True
                return entries, truncated
            entries.append(_entry(root_resolved, base / name))
    return entries, truncated


def file_for_read(root: Path, rel: str) -> Path:
    target = resolve_safe(root, rel)
    if not target.is_file():
        raise NotFound(rel)
    return target


ARCHIVE_MAX_ENTRIES = 2000


@dataclass(frozen=True, slots=True)
class ArchiveEntry:
    name: str  # path inside the archive (POSIX, as stored)
    size: int
    is_dir: bool


def archive_list(
    root: Path, rel: str, *, max_entries: int = ARCHIVE_MAX_ENTRIES
) -> tuple[list[ArchiveEntry], bool]:
    """List a zip/tar archive's members WITHOUT extracting. Returns
    (entries, truncated). Listing is read-only, so zip-slip/tar traversal in
    member names is harmless — names are surfaced as strings, never as paths."""
    target = file_for_read(root, rel)
    try:
        if zipfile.is_zipfile(target):
            with zipfile.ZipFile(target) as zf:
                infos = zf.infolist()
                truncated = len(infos) > max_entries
                entries = [
                    ArchiveEntry(name=i.filename, size=i.file_size, is_dir=i.is_dir())
                    for i in infos[:max_entries]
                ]
            return _sorted_archive(entries), truncated

        if tarfile.is_tarfile(target):
            entries = []
            truncated = False
            # Stream members (never getmembers() — a crafted tar could be huge).
            with tarfile.open(target, "r:*") as tf:
                for member in tf:
                    if len(entries) >= max_entries:
                        truncated = True
                        break
                    entries.append(
                        ArchiveEntry(
                            name=member.name,
                            size=member.size if member.isreg() else 0,
                            is_dir=member.isdir(),
                        )
                    )
            return _sorted_archive(entries), truncated
    except (zipfile.BadZipFile, tarfile.TarError, OSError, EOFError) as exc:
        # Passed the magic check but is truncated/corrupt — unlistable either way.
        raise UnsupportedArchive(rel) from exc

    raise UnsupportedArchive(rel)


def _sorted_archive(entries: list[ArchiveEntry]) -> list[ArchiveEntry]:
    return sorted(entries, key=lambda e: e.name.lower())


def write_file(root: Path, rel: str, content: bytes) -> Entry:
    target = resolve_safe(root, rel)
    if target == root.resolve():
        raise PathViolation("cannot write the workspace root")
    if target.is_dir():
        raise AlreadyExists(f"{rel!r} is a directory")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(content)
    return _entry(root.resolve(), target)


def make_dir(root: Path, rel: str) -> Entry:
    target = resolve_safe(root, rel)
    if target == root.resolve():
        raise AlreadyExists("workspace root already exists")
    if target.exists():
        raise AlreadyExists(rel)
    target.mkdir(parents=True)
    return _entry(root.resolve(), target)


def delete(root: Path, rel: str) -> None:
    target = resolve_safe(root, rel)
    if target == root.resolve():
        raise PathViolation("cannot delete the workspace root")
    if target.is_symlink() or target.is_file():
        target.unlink()
    elif target.is_dir():
        shutil.rmtree(target)
    else:
        raise NotFound(rel)


def move(root: Path, src_rel: str, dst_rel: str) -> Entry:
    src = resolve_safe(root, src_rel)
    dst = resolve_safe(root, dst_rel)
    root_resolved = root.resolve()
    if src == root_resolved or dst == root_resolved:
        raise PathViolation("cannot move the workspace root")
    if not src.exists():
        raise NotFound(src_rel)
    if dst.exists():
        raise AlreadyExists(dst_rel)
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(src), str(dst))
    return _entry(root_resolved, dst)


def search(root: Path, query: str, *, max_results: int = SEARCH_MAX_RESULTS) -> list[Entry]:
    """Case-insensitive filename-substring search, bounded."""
    q = query.lower()
    if not q:
        return []
    root_resolved = root.resolve()
    results: list[Entry] = []
    for dirpath, dirnames, filenames in os.walk(root_resolved):
        dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS)
        base = Path(dirpath)
        for name in sorted(dirnames) + sorted(filenames):
            if q in name.lower():
                results.append(_entry(root_resolved, base / name))
                if len(results) >= max_results:
                    return results
    return results


def sanitize_filename(name: str) -> str:
    """Uploads keep their EXACT name — only path separators and NULs go.

    Some hops decode the multipart filename header as latin-1, turning UTF-8
    names (e.g. Arabic) into mojibake; when a latin-1→utf-8 round-trip decodes
    cleanly we adopt the repair. Pure-ASCII names round-trip unchanged, and
    already-correct non-ASCII strings fail the encode step and are kept as-is.
    """
    with contextlib.suppress(UnicodeEncodeError, UnicodeDecodeError):
        name = name.encode("latin-1").decode("utf-8")
    base = os.path.basename(name.replace("\\", "/")).replace("\x00", "")
    if base.strip() in ("", ".", ".."):
        raise PathViolation(f"invalid filename: {name!r}")
    return base


def build_zip(root: Path, rel: str) -> BinaryIO:
    """ZIP a file/directory ('' = whole workspace) into a spooled temp file.

    Returns the file object positioned at 0, ready to stream; the caller owns
    closing it. Skips SKIP_DIRS and symlinks (a symlink's target may live
    outside the workspace).
    """
    target = resolve_safe(root, rel)
    if not target.exists():
        raise NotFound(rel)

    # SIM115 suppressed: the spool intentionally outlives this function — the
    # streaming response reads it and closes it in its finally block.
    spool: BinaryIO = tempfile.SpooledTemporaryFile(max_size=32 * 1024 * 1024)  # noqa: SIM115
    root_resolved = root.resolve()
    arc_base = target.relative_to(root_resolved).as_posix() if target != root_resolved else ""

    with zipfile.ZipFile(spool, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        if target.is_file():
            zf.write(target, target.name)
        else:
            for dirpath, dirnames, filenames in os.walk(target):
                dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS)
                base = Path(dirpath)
                for name in sorted(filenames):
                    path = base / name
                    if path.is_symlink():
                        continue
                    rel_in_zip = path.relative_to(target).as_posix()
                    prefix = f"{arc_base}/" if arc_base else ""
                    zf.write(path, f"{prefix}{rel_in_zip}")
    spool.seek(0)
    return spool
