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
its trust record. (Known v1 limit: the EFS access point maps all files to the
agent uid, so a hostile in-session agent could edit the store — acceptable at
dogfood, with control-plane-held trust as the recorded hardening path.)

Trust is CONTENT-ADDRESSED: entries are keyed by workspace-relative path for
the UI's per-file status, but the CLI gate matches on sha256 of the raw file
bytes — approving "these exact instructions", wherever they sit.
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import os
import tempfile
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath
from typing import Literal

TRUST_FILE_NAME = "blueprint-trust.json"

TrustSource = Literal["apply", "manual"]
TrustState = Literal["trusted", "untrusted", "changed"]


def trust_file_for(root: Path) -> Path:
    """The store for a workspace root — its user-dir sibling, never in-repo."""
    return root.resolve().parent / TRUST_FILE_NAME


def is_executable_path(rel: str) -> bool:
    """Is this workspace-relative path an executable definition we gate?

    v1 gates skill instructions only: ``.sanad/skills/<slug>/SKILL.md``.
    MCP/hook/agent definitions join here in later S9 phases.
    """
    parts = PurePosixPath(rel).parts
    return (
        len(parts) == 4
        and parts[0] == ".sanad"
        and parts[1] == "skills"
        and parts[2] not in ("..", ".")  # a traversal slug must never match
        and parts[3] == "SKILL.md"
    )


def file_sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_trust(root: Path) -> dict[str, dict]:
    """Entries as ``{rel_path: {sha256, trustedAt, source}}``; {} when absent.

    A corrupt store reads as empty — everything falls back to untrusted, which
    fails safe (nothing loads) rather than open.
    """
    try:
        data = json.loads(trust_file_for(root).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    entries = data.get("entries")
    if not isinstance(entries, dict):
        return {}
    return {
        k: v
        for k, v in entries.items()
        if isinstance(k, str) and isinstance(v, dict) and isinstance(v.get("sha256"), str)
    }


def record_trust(root: Path, hashes: dict[str, str], source: TrustSource) -> None:
    """Merge ``{rel_path: sha256}`` into the store atomically (tempfile+replace)."""
    if not hashes:
        return
    entries = load_trust(root)
    now = datetime.now(UTC).isoformat()
    for rel, digest in hashes.items():
        entries[rel] = {"sha256": digest, "trustedAt": now, "source": source}
    target = trust_file_for(root)
    payload = json.dumps({"version": 1, "entries": entries}, indent=2)
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
    """Workspace-relative → absolute path of every gated file present."""
    skills = root / ".sanad" / "skills"
    found: dict[str, Path] = {}
    if not skills.is_dir():
        return found
    for child in sorted(skills.iterdir()):
        skill_md = child / "SKILL.md"
        if child.is_dir() and skill_md.is_file():
            found[f".sanad/skills/{child.name}/SKILL.md"] = skill_md
    return found


def trust_statuses(root: Path) -> dict[str, dict]:
    """Per-file trust state for everything gated on disk.

    trusted   — recorded hash matches the file's current bytes
    changed   — recorded, but the file was edited since (re-review required)
    untrusted — on disk with no record (arrived outside the governed path)

    Recorded entries whose file vanished are omitted — nothing to load, so
    nothing to report.
    """
    entries = load_trust(root)
    statuses: dict[str, dict] = {}
    for rel, path in _executable_files_on_disk(root).items():
        try:
            digest = file_sha256(path)
        except OSError:
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
