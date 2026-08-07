"""Internal blueprint REST — the .sanad kernel, hosted on the project machine.

Read-only in M0: index/graph/validate/schemas. Mutations (apply/rollback) and
the watcher land with later milestones. Auth reuses ``workspace_root`` from the
workspace routes, so the same proxy credential guards these endpoints and the
user's workspace is the only reachable root (path containment is inherited —
the blueprint lives under ``<workspace>/.sanad``).
"""

from __future__ import annotations

from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse

from sanad_blueprint.graph import compile_graph
from sanad_blueprint.indexer import index_blueprint
from sanad_blueprint.schemas import json_schemas
from sanad_blueprint.validate import validate_index
from sanad_terminal.routes_workspace import workspace_root

router = APIRouter(prefix="/internal/blueprint")

Root = Annotated[Path, Depends(workspace_root)]


def _sanad_dir(root: Path) -> Path:
    return root / ".sanad"


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
