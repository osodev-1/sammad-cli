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
from dataclasses import asdict
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends
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
    plan_from_dict,
    rollback,
)
from sanad_blueprint.validate import validate_index

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


def _plan_error(exc: PlanError) -> JSONResponse:
    stale = exc.code in ("stale_plan", "precondition_failed", "duplicate_id", "edge_exists")
    return JSONResponse(
        status_code=409 if stale else 400,
        content={"error": {"code": exc.code, "message": exc.message}},
    )


@router.get("/graph")
async def graph(root: Root) -> JSONResponse:
    """The compiled graph (nodes, edges, diagnostics) for the workspace."""
    index = index_blueprint(_sanad_dir(root))
    compiled = compile_graph(index)
    payload = compiled.to_dict()
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
    action: str  # "createResource" | "createEdge"
    kind: str | None = None
    name: str | None = None
    source: str | None = None
    edgeType: str | None = None
    target: str | None = None


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
async def apply(root: Root, body: ApplyBody) -> JSONResponse:
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
        record = {
            "txId": tx_id,
            "summary": parsed.summary,
            "operations": [asdict(o) for o in parsed.operations],
            "rollback": [asdict(r) for r in result.rollback],
        }
        (_tx_dir(root) / f"{tx_id}.json").write_text(json.dumps(record), encoding="utf-8")

        graph = compile_graph(index_blueprint(_sanad_dir(root))).to_dict()

    return JSONResponse({"ok": True, "txId": tx_id, "graph": graph})


class RollbackBody(BaseModel):
    txId: str = Field(min_length=1, max_length=64)


@router.post("/rollback")
async def rollback_tx(root: Root, body: RollbackBody) -> JSONResponse:
    """Undo a transaction by replaying its rollback record."""
    record_path = _tx_dir(root) / f"{body.txId}.json"
    if not record_path.is_file():
        return JSONResponse(
            status_code=404,
            content={"error": {"code": "not_found", "message": "no such transaction"}},
        )
    async with _lock_for(root):
        record = json.loads(record_path.read_text(encoding="utf-8"))
        entries = [
            RollbackEntry(path=e["path"], action=e["action"], prior_content=e.get("prior_content"))
            for e in record.get("rollback", [])
        ]
        await asyncio.to_thread(rollback, root, entries)
        record_path.unlink(missing_ok=True)
        graph = compile_graph(index_blueprint(_sanad_dir(root))).to_dict()
    return JSONResponse({"ok": True, "graph": graph})
