"""Machine-local trust store for executable blueprint definitions (S9, §19.3).

The blueprint's *declarative* manifests (skill.yaml, agent.yaml) describe the
graph; its *executable* definitions (a skill's SKILL.md instructions) are
content the runtime will hand to a model. Those load only when TRUSTED:

- Content applied through the governed plan→review→apply path is recorded as
  trusted at apply time — the review modal WAS the human review (Omar,
  2026-08-09). ``source: "apply"``.
- Content arriving any other way (a terminal-agent write, a git pull, a direct
  edit) sits untrusted — badged in the graph — until reviewed once in the UI.
  ``source: "manual"``.

The store lives at ``<workspace>/../blueprint-trust.json`` — the machine's
user-dir, OUTSIDE the git workspace. An in-repo trust file would let pulled
content trust itself; out-of-repo, a clone/pull can bring content but never
its trust record. (v2 design: the EFS access point maps all files to the
agent uid, so file ownership can never protect the store from a hostile
in-session agent — instead every write is HMAC-signed and every read
verified, and a store that fails verification fails CLOSED (nothing loads,
every gated file reads "tampered") rather than falling back to the
untrustworthy content on disk. The key lives only in agentd's root-owned
environment, never in the child agent's env — inline delivery of the key
from agentd to this service is the next task.)

Trust is CONTENT-ADDRESSED: entries are keyed by workspace-relative path for
the UI's per-file status, but the CLI gate matches on sha256 of the raw file
bytes — approving "these exact instructions", wherever they sit.
"""

from __future__ import annotations

import contextlib
import hashlib
import hmac
import json
import os
import tempfile
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath
from typing import Literal

TRUST_FILE_NAME = "blueprint-trust.json"

TrustSource = Literal["apply", "manual"]
TrustState = Literal["trusted", "untrusted", "changed", "tampered"]


def trust_file_for(root: Path) -> Path:
    """The store for a workspace root — its user-dir sibling, never in-repo."""
    return root.resolve().parent / TRUST_FILE_NAME


# Executable definitions we gate, by (kind directory, gated filename). Skills
# gate their instructions; MCP servers gate the manifest itself (it names the
# command/URL an agent session will actually run/connect to). Hooks and
# runnable agents join as their activation rungs land (R5).
_GATED: tuple[tuple[str, str], ...] = (
    ("skills", "SKILL.md"),
    ("mcps", "mcp.yaml"),
)


def is_executable_path(rel: str) -> bool:
    """Is this workspace-relative path an executable definition we gate?"""
    parts = PurePosixPath(rel).parts
    return (
        len(parts) == 4
        and parts[0] == ".sanad"
        and parts[2] not in ("..", ".")  # a traversal slug must never match
        and (parts[1], parts[3]) in _GATED
    )


def file_sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _canonical(entries: dict[str, dict]) -> bytes:
    return json.dumps(entries, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _sign(entries: dict[str, dict], key: str) -> str:
    return hmac.new(key.encode("utf-8"), _canonical(entries), hashlib.sha256).hexdigest()


def load_trust_checked(root: Path, *, key: str = "") -> tuple[dict[str, dict], bool]:
    """(entries, tampered). Empty key = legacy: never tampered, current behavior
    (a corrupt or absent store reads as empty and everything falls back to
    untrusted — fails safe rather than open).

    With a key: only a v2 store with a valid signature loads; anything else —
    bad signature, a v1 (unsigned) store, or a malformed store — is
    ``({}, True)``: fail closed, surfaced to the caller instead of silently
    treating tampered content as merely empty.
    """
    try:
        data = json.loads(trust_file_for(root).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}, bool(key)
    if not isinstance(data, dict):
        return {}, bool(key)
    entries = data.get("entries")
    if not isinstance(entries, dict):
        return {}, bool(key)
    if key:
        # A legacy v1 (unsigned) store loaded with a key is NOT trusted as
        # empty-but-fine — it fails closed, same as a bad signature. The only
        # way back to a valid v2 store is a fresh record (see record_trust).
        if data.get("version") != 2:
            return {}, True
        sig = data.get("sig")
        if not isinstance(sig, str) or not hmac.compare_digest(_sign(entries, key), sig):
            return {}, True
    clean = {
        k: v
        for k, v in entries.items()
        if isinstance(k, str) and isinstance(v, dict) and isinstance(v.get("sha256"), str)
    }
    return clean, False


def load_trust(root: Path, *, key: str = "") -> dict[str, dict]:
    """Entries as ``{rel_path: {sha256, trustedAt, source}}``; {} when absent
    or (with a key) when the store fails signature verification.
    """
    return load_trust_checked(root, key=key)[0]


def record_trust(
    root: Path, hashes: dict[str, str], source: TrustSource, *, key: str = ""
) -> None:
    """Merge ``{rel_path: sha256}`` into the store atomically (tempfile+replace)."""
    if not hashes:
        return
    entries, tampered = load_trust_checked(root, key=key)
    if tampered:
        # Recovery path: never merge on top of a store that failed
        # verification — a re-record after tamper detection rebuilds a clean
        # signed store from empty rather than trusting anything on disk.
        entries = {}
    now = datetime.now(UTC).isoformat()
    for rel, digest in hashes.items():
        entries[rel] = {"sha256": digest, "trustedAt": now, "source": source}
    _write_store(root, entries, key=key)


def remove_trust(root: Path, rels: list[str], *, key: str = "") -> None:
    """Drop entries for deleted definitions — an orphaned trust record must
    never vouch for content that later reappears at the same path."""
    if not rels:
        return
    entries, tampered = load_trust_checked(root, key=key)
    if tampered:
        # Recovery path: never merge on top of a store that failed
        # verification — a re-record after tamper detection rebuilds a clean
        # signed store from empty rather than trusting anything on disk.
        entries = {}
    changed = False
    for rel in rels:
        if rel in entries:
            del entries[rel]
            changed = True
    if changed:
        _write_store(root, entries, key=key)


def _write_store(root: Path, entries: dict[str, dict], *, key: str = "") -> None:
    target = trust_file_for(root)
    if key:
        body: dict = {"version": 2, "entries": entries, "sig": _sign(entries, key)}
    else:
        body = {"version": 1, "entries": entries}
    payload = json.dumps(body, indent=2)
    fd, tmp = tempfile.mkstemp(dir=str(target.parent), prefix=".trust-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(payload)
        os.replace(tmp, target)
    except OSError:
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        raise


def _executable_files_on_disk(root: Path) -> dict[str, Path]:
    """Workspace-relative → absolute path of every gated file present.

    Walks every _GATED (kind dir, filename) pair — a gated kind whose files
    the walker cannot see gets trust records at apply time but no status in
    the UI, so untrusted/changed content of that kind would be invisible to
    review (the R5 rung-1 gap: mcps/ was gated but never walked)."""
    found: dict[str, Path] = {}
    for kind_dir, gated_name in _GATED:
        base = root / ".sanad" / kind_dir
        if not base.is_dir():
            continue
        for child in sorted(base.iterdir()):
            gated = child / gated_name
            if child.is_dir() and gated.is_file():
                found[f".sanad/{kind_dir}/{child.name}/{gated_name}"] = gated
    return found


def trust_statuses(root: Path, *, key: str = "") -> dict[str, dict]:
    """Per-file trust state for everything gated on disk.

    trusted   — recorded hash matches the file's current bytes
    changed   — recorded, but the file was edited since (re-review required)
    untrusted — on disk with no record (arrived outside the governed path)
    tampered  — (keyed mode only) the store failed signature verification;
                every gated file on disk reports tampered regardless of what
                the untrustworthy store claims — fail closed, not per-entry

    Recorded entries whose file vanished are omitted — nothing to load, so
    nothing to report.
    """
    entries, tampered = load_trust_checked(root, key=key)
    statuses: dict[str, dict] = {}
    for rel, path in _executable_files_on_disk(root).items():
        try:
            digest = file_sha256(path)
        except OSError:
            continue
        if tampered:
            statuses[rel] = {
                "status": "tampered",
                "sha256": digest,
                "source": None,
                "trustedAt": None,
            }
            continue
        recorded = entries.get(rel)
        state: TrustState
        if recorded is None:
            state = "untrusted"
        elif recorded["sha256"] == digest:
            state = "trusted"
        else:
            state = "changed"
        statuses[rel] = {
            "status": state,
            "sha256": digest,
            "source": recorded.get("source") if recorded else None,
            "trustedAt": recorded.get("trustedAt") if recorded else None,
        }
    return statuses
