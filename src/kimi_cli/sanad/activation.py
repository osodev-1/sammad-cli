"""Runtime activation (S9/R5): blueprint definitions become live capability.

Governed workspaces (sanadcode.com machines) export ``SANAD_BLUEPRINT_TRUST``
— the machine-local trust store recording the sha256 of every human-reviewed
executable definition. With the env set, TRUSTED ``.sanad`` definitions load
into the agent at construction; unreviewed content (agent-written, git-pulled)
stays inert until someone reads it. Local CLIs never set the env, so their
behavior is untouched.

This module is the .sanad→runtime adapter's home: MCP servers now; hooks and
runnable agents join as their rungs land. Everything here is synchronous
stdlib — it runs once at CLI boot against the machine's local filesystem, and
every failure degrades to "definition not loaded", never a crash.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Any, cast

import yaml


def _trusted_hashes() -> frozenset[str] | None:
    """Sha256 values of reviewed definitions; None = gate absent or unreadable.

    An unreadable/corrupt store fails CLOSED (load nothing) — matching the
    skill gate's posture.
    """
    # P2a inline delivery: present-even-empty wins over the legacy file var —
    # governed machines hand the CLI the VERIFIED hash set directly at exec
    # time, so the store file is never re-read (and can't be poisoned
    # in-session between spawn and read).
    inline = os.environ.get("SANAD_BLUEPRINT_TRUST_SHA256S")
    if inline is not None:
        return frozenset(h for h in inline.split(",") if h)

    trust_path = os.environ.get("SANAD_BLUEPRINT_TRUST")
    if not trust_path:
        return None
    try:
        data: object = json.loads(Path(trust_path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return frozenset()
    if not isinstance(data, dict):
        return frozenset()
    entries = cast("dict[str, object]", data).get("entries")
    if not isinstance(entries, dict):
        return frozenset()
    out: set[str] = set()
    for value in cast("dict[str, object]", entries).values():
        if not isinstance(value, dict):
            continue
        digest = cast("dict[str, object]", value).get("sha256")
        if isinstance(digest, str):
            out.add(digest)
    return frozenset(out)


def workspace_mcp_configs(work_dir: Path) -> list[dict[str, Any]]:
    """Trusted ``.sanad/mcps/*/mcp.yaml`` manifests → fastmcp config dicts.

    Only on governed machines (env gate), and only manifests whose RAW BYTES
    hash to a reviewed digest — the manifest names the command/URL an agent
    session will actually run, so it is gated exactly like skill instructions.
    Returns at most one ``{"mcpServers": {...}}`` entry.
    """
    trusted = _trusted_hashes()
    if trusted is None:
        return []  # not a governed workspace — local CLIs are untouched

    mcps_dir = work_dir / ".sanad" / "mcps"
    if not mcps_dir.is_dir():
        return []

    servers: dict[str, dict[str, Any]] = {}
    try:
        children = sorted(p for p in mcps_dir.iterdir() if p.is_dir())
    except OSError:
        return []
    for child in children:
        manifest = child / "mcp.yaml"
        try:
            raw = manifest.read_bytes()
        except OSError:
            continue
        if hashlib.sha256(raw).hexdigest() not in trusted:
            continue  # unreviewed — stays inert until someone reads it
        try:
            doc = yaml.safe_load(raw)
        except yaml.YAMLError:
            continue
        if not isinstance(doc, dict):
            continue
        raw_spec = cast("dict[str, object]", doc).get("spec")
        spec: dict[str, object] = (
            cast("dict[str, object]", raw_spec) if isinstance(raw_spec, dict) else {}
        )
        entry = _mcp_entry(spec)
        if entry is not None:
            servers[child.name] = entry
    return [{"mcpServers": servers}] if servers else []


def _mcp_entry(spec: dict[str, object]) -> dict[str, Any] | None:
    """One manifest spec → one fastmcp server entry (None = not runnable)."""
    transport = spec.get("transport", "stdio")
    if transport == "stdio":
        command = spec.get("command")
        if not isinstance(command, str) or not command:
            return None
        entry: dict[str, Any] = {"command": command}
        args = spec.get("args")
        if isinstance(args, list):
            raw_args = cast("list[object]", args)
            typed_args = [a for a in raw_args if isinstance(a, str)]
            if len(typed_args) == len(raw_args):
                entry["args"] = typed_args
        env = spec.get("env")
        if isinstance(env, dict):
            raw_env = cast("dict[object, object]", env)
            typed_env = {
                k: v for k, v in raw_env.items() if isinstance(k, str) and isinstance(v, str)
            }
            if len(typed_env) == len(raw_env):
                entry["env"] = typed_env
        return entry
    if transport in ("http", "sse"):
        url = spec.get("url")
        if not isinstance(url, str) or not url.startswith(("http://", "https://")):
            return None
        return {"url": url}
    return None
