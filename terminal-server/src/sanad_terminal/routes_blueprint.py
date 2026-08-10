"""Internal blueprint REST — the .sanad kernel, hosted on the project machine.

Reads (index/graph/validate/schemas) and writes (plan/apply/rollback). Auth
reuses ``workspace_root`` from the workspace routes, so the same proxy
credential guards these endpoints and the user's workspace is the only
reachable root (the blueprint lives under ``<workspace>/.sanad``).

Writes run under a per-workspace lock so the sha256 preconditions and the file
writes are atomic against a concurrent PTY-agent edit. Transaction records
live under ``.sanad/.cache/transactions`` (disposable, machine-local).
"""

from __future__ import annotations

import asyncio
import json
import uuid
from datetime import UTC, datetime
from dataclasses import asdict
from pathlib import Path, PurePosixPath
from typing import Annotated

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sanad_blueprint.graph import compile_graph
from sanad_blueprint.indexer import index_blueprint
from sanad_blueprint.schemas import ResourceKind, json_schemas
from sanad_blueprint.templates import CREATABLE_KINDS
from sanad_blueprint.transaction import (
    PlanError,
    RollbackEntry,
    apply_plan,
    plan_create_edge,
    plan_create_resource,
    plan_delete_resource,
    plan_from_dict,
    plan_remove_edge,
    rollback,
)
from sanad_blueprint.validate import validate_index

from sanad_terminal.blueprint_trust import (
    file_sha256,
    is_executable_path,
    record_trust,
    remove_trust,
    trust_statuses,
)
from sanad_terminal.routes_workspace import workspace_root

router = APIRouter(prefix="/internal/blueprint")

Root = Annotated[Path, Depends(workspace_root)]

# One lock per workspace root — writes serialize; reads are lock-free.
_locks: dict[str, asyncio.Lock] = {}


def _lock_for(root: Path) -> asyncio.Lock:
    key = str(root)
    if key not in _locks:
        _locks[key] = asyncio.Lock()
    return _locks[key]


def _sanad_dir(root: Path) -> Path:
    return root / ".sanad"


def _tx_dir(root: Path) -> Path:
    d = _sanad_dir(root) / ".cache" / "transactions"
    d.mkdir(parents=True, exist_ok=True)
    return d


_TX_KEEP = 50


def _prune_tx(root: Path) -> None:
    """Keep the newest records only — the cache is instant-undo, not history
    (git is history)."""
    records = sorted(
        _tx_dir(root).glob("tx_*.json"), key=lambda p: p.stat().st_mtime, reverse=True
    )
    for stale in records[_TX_KEEP:]:
        stale.unlink(missing_ok=True)


async def _auto_commit(request: Request, root: Path, message: str) -> bool:
    """Commit .sanad with the signed-in user's identity (proxy-injected
    headers; the browser can't spoof them). False on any git trouble."""
    try:
        from sanad_terminal.routes_git import _repo

        author = request.headers.get("x-author-name") or "Sanad Workspace"
        email = request.headers.get("x-author-email") or "workspace@sanadcode.com"
        await _repo(request, root).commit_paths([".sanad"], message, author, email)
        return True
    except Exception:
        return False


def _plan_error(exc: PlanError) -> JSONResponse:
    stale = exc.code in ("stale_plan", "precondition_failed", "duplicate_id", "edge_exists")
    return JSONResponse(
        status_code=409 if stale else 400,
        content={"error": {"code": exc.code, "message": exc.message}},
    )


def _annotate_trust(payload: dict, root: Path) -> dict:
    """Stamp each skill node with its executable definition's trust state.

    A skill node's manifest path is ``.sanad/skills/<slug>/skill.yaml``; its
    gated instructions sit beside it as ``SKILL.md``. Nodes without a gated
    file (no SKILL.md yet) carry no ``trust`` key at all.
    """
    statuses = trust_statuses(root)
    if not statuses:
        return payload
    for node in payload.get("nodes", []):
        p = node.get("path") or ""
        if p.startswith(".sanad/skills/"):
            key = str(PurePosixPath(p).parent / "SKILL.md")
            if key in statuses:
                node["trust"] = statuses[key]["status"]
    return payload


async def _annotate_git(payload: dict, request: Request, root: Path) -> dict:
    """Stamp each node with its committed-ness: ``modified`` (tracked files
    with uncommitted changes) or ``untracked`` (never committed); clean nodes
    carry nothing. Degrades to a no-op when the workspace has no repo or git
    fails — the graph must never depend on git health.

    Porcelain nuance: an entirely-new resource folder appears as ONE untracked
    entry ``dir/`` (git does not enumerate inside untracked directories), so
    untracked matching is prefix-aware.
    """
    try:
        from sanad_terminal.routes_git import _repo

        st = await _repo(request, root).status()
    except Exception:
        return payload
    if not st.is_repo:
        return payload
    dirty = set(st.staged) | set(st.unstaged)
    untracked_files = {p for p in st.untracked if not p.endswith("/")}
    untracked_dirs = tuple(p for p in st.untracked if p.endswith("/"))

    def _is_untracked(path: str) -> bool:
        return path in untracked_files or path.startswith(untracked_dirs)

    for node in payload.get("nodes", []):
        paths = [node.get("path"), *node.get("supporting_paths", [])]
        paths = [p for p in paths if isinstance(p, str)]
        if any(p in dirty for p in paths):
            node["git"] = "modified"
        elif untracked_dirs or untracked_files:
            if any(_is_untracked(p) for p in paths):
                node["git"] = "untracked"
    return payload


@router.get("/graph")
async def graph(request: Request, root: Root) -> JSONResponse:
    """The compiled graph (nodes, edges, diagnostics) for the workspace."""
    index = index_blueprint(_sanad_dir(root))
    compiled = compile_graph(index)
    payload = _annotate_trust(compiled.to_dict(), root)
    payload = await _annotate_git(payload, request, root)
    payload["initialized"] = _sanad_dir(root).is_dir()
    return JSONResponse(payload)


@router.get("/resource")
async def resource(root: Root, id: str) -> JSONResponse:
    """One resource: its manifest, supporting files, and diagnostics."""
    index = index_blueprint(_sanad_dir(root))
    indexed = index.resources.get(id)
    if indexed is None:
        return JSONResponse(
            status_code=404,
            content={"error": {"code": "not_found", "message": f"no resource {id!r}"}},
        )
    diags = [d.model_dump() for d in index.diagnostics if d.resource_id == id]
    return JSONResponse(
        {
            "id": id,
            "kind": indexed.resource.kind.value,
            "name": indexed.resource.metadata.name,
            "manifestPath": indexed.manifest_path,
            "supportingPaths": indexed.supporting_paths,
            "spec": indexed.resource.spec.model_dump(),
            "diagnostics": diags,
        }
    )


@router.post("/validate")
async def validate(root: Root) -> JSONResponse:
    """Full validation report for the workspace blueprint."""
    report = validate_index(index_blueprint(_sanad_dir(root)))
    return JSONResponse(
        {
            "ok": report.ok,
            "diagnostics": [d.model_dump() for d in report.diagnostics],
        }
    )


@router.get("/schemas")
async def schemas() -> JSONResponse:
    """JSON Schema per resource kind — powers the web UI's forms/validation."""
    return JSONResponse({"schemas": json_schemas()})


@router.get("/templates")
async def templates() -> JSONResponse:
    """Kinds a user can scaffold, with the id prefix each uses."""
    from sanad_blueprint.schemas import KIND_ID_PREFIX

    return JSONResponse(
        {"kinds": [{"kind": k.value, "prefix": KIND_ID_PREFIX[k]} for k in CREATABLE_KINDS]}
    )


class PlanBody(BaseModel):
    action: str  # "createResource" | "createEdge" | "deleteResource" | "removeEdge"
    kind: str | None = None
    name: str | None = None
    source: str | None = None
    edgeType: str | None = None
    target: str | None = None
    id: str | None = None  # deleteResource


@router.post("/plan")
async def plan(root: Root, body: PlanBody) -> JSONResponse:
    """Build (but do not apply) a change plan — the UI previews it first."""
    index = index_blueprint(_sanad_dir(root))
    try:
        if body.action == "createResource":
            if not body.kind or not body.name:
                return JSONResponse(
                    status_code=400,
                    content={
                        "error": {"code": "invalid_request", "message": "kind and name required"}
                    },
                )
            try:
                kind = ResourceKind(body.kind)
            except ValueError:
                return JSONResponse(
                    status_code=400,
                    content={"error": {"code": "unknown_kind", "message": body.kind}},
                )
            built = plan_create_resource(index, kind, body.name)
        elif body.action == "createEdge":
            if not (body.source and body.target):
                return JSONResponse(
                    status_code=400,
                    content={
                        "error": {
                            "code": "invalid_request",
                            "message": "source and target required",
                        }
                    },
                )
            # edgeType is optional: omitted → infer the legal relationship.
            built = plan_create_edge(index, body.source, body.target, body.edgeType)
        elif body.action == "deleteResource":
            if not body.id:
                return JSONResponse(
                    status_code=400,
                    content={"error": {"code": "invalid_request", "message": "id required"}},
                )
            built = plan_delete_resource(index, body.id)
        elif body.action == "removeEdge":
            if not (body.source and body.target):
                return JSONResponse(
                    status_code=400,
                    content={
                        "error": {
                            "code": "invalid_request",
                            "message": "source and target required",
                        }
                    },
                )
            built = plan_remove_edge(index, body.source, body.target, body.edgeType)
        else:
            return JSONResponse(
                status_code=400,
                content={"error": {"code": "unknown_action", "message": body.action}},
            )
    except PlanError as exc:
        return _plan_error(exc)
    return JSONResponse({"plan": built.to_dict()})


class ApplyBody(BaseModel):
    plan: dict = Field(default_factory=dict)


@router.post("/apply")
async def apply(request: Request, root: Root, body: ApplyBody) -> JSONResponse:
    """Apply an approved plan atomically; record it; return the fresh graph."""
    try:
        parsed = plan_from_dict(body.plan)
    except Exception:
        return JSONResponse(
            status_code=400,
            content={"error": {"code": "invalid_plan", "message": "malformed plan"}},
        )

    async with _lock_for(root):
        try:
            result = await asyncio.to_thread(apply_plan, root, parsed)
        except PlanError as exc:
            return _plan_error(exc)

        tx_id = f"tx_{uuid.uuid4().hex[:16]}"
        # Post-apply hashes anchor SAFE revert: rollback replays only when the
        # tree still looks exactly like this apply left it (R3).
        after_hashes = {
            op.path: (file_sha256(root / op.path) if (root / op.path).is_file() else None)
            for op in parsed.operations
        }
        record = {
            "txId": tx_id,
            "createdAt": datetime.now(UTC).isoformat(),
            "summary": parsed.summary,
            "operations": [asdict(o) for o in parsed.operations],
            "rollback": [asdict(r) for r in result.rollback],
            "after": after_hashes,
        }
        (_tx_dir(root) / f"{tx_id}.json").write_text(json.dumps(record), encoding="utf-8")
        _prune_tx(root)

        # Apply IS the trust review (S9): the user just read these exact files
        # in the review modal, so executable definitions the plan wrote are
        # recorded as trusted at their as-written hash. Content arriving any
        # other way stays untrusted until reviewed in the UI.
        applied_executables = {
            op.path: file_sha256(root / op.path)
            for op in parsed.operations
            if is_executable_path(op.path) and (root / op.path).is_file()
        }
        if applied_executables:
            record_trust(root, applied_executables, "apply")
        # Deleted executable definitions lose their trust entries — an orphaned
        # record must never vouch for content recreated later at the same path.
        deleted_executables = [
            op.path
            for op in parsed.operations
            if op.op == "delete" and is_executable_path(op.path)
        ]
        if deleted_executables:
            remove_trust(root, deleted_executables)

        # R3: every governed apply lands in git — the durable, diffable history
        # the committedness ring and the History timeline read from. Scoped to
        # .sanad so a user's unrelated workspace edits are never swept in.
        # Non-fatal: the apply already succeeded; a git hiccup only means the
        # ring shows uncommitted until the next commit.
        committed = await _auto_commit(
            request, root, f"blueprint: {parsed.summary} [{tx_id}]"
        )

        graph = _annotate_trust(compile_graph(index_blueprint(_sanad_dir(root))).to_dict(), root)
        graph = await _annotate_git(graph, request, root)

    return JSONResponse({"ok": True, "txId": tx_id, "committed": committed, "graph": graph})


class RollbackBody(BaseModel):
    txId: str = Field(min_length=1, max_length=64)


@router.post("/rollback")
async def rollback_tx(request: Request, root: Root, body: RollbackBody) -> JSONResponse:
    """Undo a transaction by replaying its rollback record.

    SAFE (R3): replay happens only while the tree still looks exactly like
    the apply left it — every path is re-hashed against the record's
    post-apply state, and any drift (a later apply, a PTY-agent edit) refuses
    with 409 stale_rollback pointing the user at git history instead of
    silently clobbering the newer work.
    """
    record_path = _tx_dir(root) / f"{body.txId}.json"
    if not record_path.is_file():
        return JSONResponse(
            status_code=404,
            content={"error": {"code": "not_found", "message": "no such transaction"}},
        )
    async with _lock_for(root):
        record = json.loads(record_path.read_text(encoding="utf-8"))
        after = record.get("after")
        if isinstance(after, dict):
            for rel, expected in after.items():
                target = root / rel
                actual = file_sha256(target) if target.is_file() else None
                if actual != expected:
                    return JSONResponse(
                        status_code=409,
                        content={
                            "error": {
                                "code": "stale_rollback",
                                "message": (
                                    f"{rel} changed after this apply — revert from "
                                    "the history timeline instead"
                                ),
                            }
                        },
                    )
        entries = [
            RollbackEntry(path=e["path"], action=e["action"], prior_content=e.get("prior_content"))
            for e in record.get("rollback", [])
        ]
        await asyncio.to_thread(rollback, root, entries)
        record_path.unlink(missing_ok=True)
        # Trust follows the tree: re-record what the revert restored, drop what
        # it removed (mirrors apply's own bookkeeping).
        restored_exec = {
            e["path"]: file_sha256(root / e["path"])
            for e in record.get("rollback", [])
            if is_executable_path(e["path"]) and (root / e["path"]).is_file()
        }
        if restored_exec:
            record_trust(root, restored_exec, "apply")
        gone_exec = [
            e["path"]
            for e in record.get("rollback", [])
            if is_executable_path(e["path"]) and not (root / e["path"]).is_file()
        ]
        if gone_exec:
            remove_trust(root, gone_exec)
        committed = await _auto_commit(
            request, root, f"blueprint: revert {record.get('summary', body.txId)} [{body.txId}]"
        )
        graph = _annotate_trust(compile_graph(index_blueprint(_sanad_dir(root))).to_dict(), root)
        graph = await _annotate_git(graph, request, root)
    return JSONResponse({"ok": True, "committed": committed, "graph": graph})


@router.get("/trust")
async def trust_list(root: Root) -> JSONResponse:
    """Per-file trust state for every gated executable definition on disk."""
    entries = await asyncio.to_thread(trust_statuses, root)
    return JSONResponse({"entries": entries})


class TrustBody(BaseModel):
    path: str = Field(min_length=1, max_length=512)


@router.post("/trust")
async def trust_review(root: Root, body: TrustBody) -> JSONResponse:
    """The one-time manual review: trust a file at its CURRENT content.

    This is the UI action for definitions that arrived outside the governed
    apply path (terminal-agent writes, git pulls, direct edits). Recording is
    under the workspace lock so the hash written is the hash reviewed — not a
    file that changed mid-request.
    """
    rel = body.path
    if not is_executable_path(rel):
        return JSONResponse(
            status_code=400,
            content={"error": {"code": "not_executable", "message": "not a gated definition path"}},
        )
    async with _lock_for(root):
        target = root / rel
        if not target.is_file():
            return JSONResponse(
                status_code=404,
                content={"error": {"code": "not_found", "message": "no such file"}},
            )
        digest = await asyncio.to_thread(file_sha256, target)
        await asyncio.to_thread(record_trust, root, {rel: digest}, "manual")
        entries = await asyncio.to_thread(trust_statuses, root)
    return JSONResponse({"ok": True, "entries": entries})
