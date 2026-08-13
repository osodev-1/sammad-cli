"""Blueprint tools for the Sanad Architect agent — read and *draft* only.

These power ``sanad --agent architect``. They let the agent inspect the compiled
``.sanad`` graph, validate it, and DRAFT change plans — but never write or apply.
Applying is a separate, user-driven step through agentd's transaction endpoint
(the same one manual authoring uses), so governance is *structural*: the
architect simply has no tool that mutates the blueprint.

The kernel (``sanad_blueprint``) is a direct dependency of this package, so the
tools call it in-process against the workspace's ``.sanad`` — no HTTP, no auth.

Note: there is deliberately no ``from __future__ import annotations`` here. The
toolset injects constructor dependencies by matching each ``__init__``
parameter's *runtime* annotation object against a type→instance map; stringized
annotations (what the future import produces) would break that lookup.
"""

import json
from pathlib import Path
from typing import Literal, cast, override

from kosong.tooling import BriefDisplayBlock, CallableTool2, ToolError, ToolOk, ToolReturnValue
from kosong.utils.typing import JsonType
from pydantic import BaseModel, Field

from kimi_cli.soul.agent import Runtime


def _sanad_dir(runtime: Runtime) -> Path:
    """The workspace's ``.sanad`` directory.

    The architect runs with its working directory set to the project workspace,
    so the blueprint is ``<cwd>/.sanad``. ``KIMI_WORK_DIR`` is a KaosPath; the
    machine's filesystem is local, so unwrapping to a plain Path is safe here.
    """
    work_dir = runtime.builtin_args.KIMI_WORK_DIR.unsafe_to_local_path()
    return work_dir / ".sanad"


_NO_BLUEPRINT = "No .sanad blueprint exists yet in this workspace."


class _NoParams(BaseModel):
    pass


class BlueprintGraph(CallableTool2[_NoParams]):
    name: str = "BlueprintGraph"
    description: str = (
        "Inspect the compiled .sanad blueprint graph: every resource (agents, "
        "skills, tools, MCP servers, hooks, policies, …) with its status, the "
        "typed edges between them, and any diagnostics. Read-only."
    )
    params: type[_NoParams] = _NoParams

    def __init__(self, runtime: Runtime) -> None:
        super().__init__()
        self._runtime = runtime

    @override
    async def __call__(self, params: _NoParams) -> ToolReturnValue:
        from sanad_blueprint.graph import compile_graph
        from sanad_blueprint.indexer import index_blueprint

        sanad = _sanad_dir(self._runtime)
        if not sanad.is_dir():
            return ToolError(message=_NO_BLUEPRINT, brief="No blueprint")
        compiled = compile_graph(index_blueprint(sanad))
        return ToolOk(
            output=json.dumps(compiled.to_dict(), ensure_ascii=False, indent=2),
            message="Compiled blueprint graph.",
            brief=f"{len(compiled.nodes)} node(s)",
        )


class BlueprintValidate(CallableTool2[_NoParams]):
    name: str = "BlueprintValidate"
    description: str = (
        "Validate the .sanad blueprint and return every diagnostic (broken "
        "references, delegation cycles, schema errors). Read-only."
    )
    params: type[_NoParams] = _NoParams

    def __init__(self, runtime: Runtime) -> None:
        super().__init__()
        self._runtime = runtime

    @override
    async def __call__(self, params: _NoParams) -> ToolReturnValue:
        from sanad_blueprint.validate import validate_blueprint

        sanad = _sanad_dir(self._runtime)
        if not sanad.is_dir():
            return ToolError(message=_NO_BLUEPRINT, brief="No blueprint")
        report = validate_blueprint(sanad)
        payload = {
            "ok": report.ok,
            "diagnostics": [d.model_dump(mode="json") for d in report.diagnostics],
        }
        return ToolOk(
            output=json.dumps(payload, ensure_ascii=False, indent=2),
            message="Blueprint is valid." if report.ok else "Blueprint has diagnostics.",
            brief="valid" if report.ok else f"{len(report.diagnostics)} diagnostic(s)",
        )


class FileDraft(BaseModel):
    path: str = Field(
        description=(
            "Workspace-relative path under .sanad/ (e.g. "
            ".sanad/skills/code-review/SKILL.md). Plans may only touch .sanad/."
        )
    )
    content: str | None = Field(
        default=None,
        description=(
            "The COMPLETE desired content of the file — what it should contain "
            "after apply, not a diff or a fragment. Omit (with delete=true) to "
            "DELETE the file instead."
        ),
    )
    delete: bool = Field(
        default=False,
        description="True to delete this file (content must be omitted).",
    )


class DraftParams(BaseModel):
    action: Literal[
        "writeFiles", "createResource", "createEdge", "deleteResource", "removeEdge"
    ] = Field(
        description=(
            "writeFiles to draft REAL file contents — new resources with "
            "substantive definitions, edits, or per-file deletions (preferred); "
            "createResource to scaffold an empty template; createEdge/removeEdge "
            "to connect or disconnect two existing resources; deleteResource to "
            "remove a resource entirely (its files AND every reference to it)."
        )
    )
    files: list[FileDraft] | None = Field(
        default=None,
        description=(
            "writeFiles only: every file to write or delete. Writes carry the "
            "complete content (read existing files first); deletions set "
            "delete=true. Removing a whole resource: prefer deleteResource."
        ),
    )
    id: str | None = Field(
        default=None,
        description="deleteResource only: the resource id (e.g. skill:code-review).",
    )
    summary: str | None = Field(
        default=None,
        description=(
            "writeFiles only: one reviewable sentence describing the change "
            "(e.g. 'Define the Code Review agent and its skill instructions')."
        ),
    )
    kind: str | None = Field(
        default=None,
        description=(
            "createResource only: the kind to scaffold — one of Agent, Skill, "
            "Tool, MCPServer, Hook, Policy."
        ),
    )
    name: str | None = Field(
        default=None,
        description="createResource only: a human-readable name (e.g. 'Code Review').",
    )
    source: str | None = Field(
        default=None,
        description="createEdge only: the source resource id (e.g. agent:primary).",
    )
    target: str | None = Field(
        default=None,
        description="createEdge only: the target resource id (e.g. skill:code-review).",
    )
    edge_type: str | None = Field(
        default=None,
        description=(
            "createEdge only: the relationship type (e.g. uses, invokes, "
            "governed_by). Omit to infer the only legal relationship between the "
            "two kinds."
        ),
    )


class DraftBlueprintChange(CallableTool2[DraftParams]):
    name: str = "DraftBlueprintChange"
    description: str = (
        "Draft (do NOT apply) a change to the .sanad blueprint. Prefer "
        "action=writeFiles: supply the complete desired content of each file — "
        "a new resource's real manifest and instructions, or the full updated "
        "content of existing files — so drafts carry substance, never bare "
        "scaffolding. Read current files before editing them; after the user "
        "applies, re-read and keep iterating. createResource exists for an "
        "empty template; createEdge connects two existing resources. Returns a "
        "reviewable change plan the user applies themselves. This tool never "
        "writes to disk; you cannot apply changes."
    )
    params: type[DraftParams] = DraftParams

    def __init__(self, runtime: Runtime) -> None:
        super().__init__()
        self._runtime = runtime

    @override
    async def __call__(self, params: DraftParams) -> ToolReturnValue:
        from sanad_blueprint.indexer import index_blueprint
        from sanad_blueprint.schemas import ResourceKind
        from sanad_blueprint.templates import CREATABLE_KINDS
        from sanad_blueprint.transaction import (
            PlanError,
            plan_create_edge,
            plan_create_resource,
            plan_delete_resource,
            plan_remove_edge,
            plan_write_files,
        )

        sanad = _sanad_dir(self._runtime)
        if not sanad.is_dir():
            return ToolError(
                message=f"{_NO_BLUEPRINT} Initialize one before drafting changes.",
                brief="No blueprint",
            )
        index = index_blueprint(sanad)

        try:
            if params.action == "writeFiles":
                if not params.files:
                    return ToolError(
                        message=(
                            "writeFiles needs `files` — each with a path and its "
                            "complete content (or delete=true)."
                        ),
                        brief="Missing files",
                    )
                for f in params.files:
                    if not f.delete and f.content is None:
                        return ToolError(
                            message=f"{f.path}: provide content, or set delete=true.",
                            brief="Missing content",
                        )
                plan = plan_write_files(
                    index,
                    [(f.path, None if f.delete else f.content) for f in params.files],
                    params.summary or "Update the blueprint",
                )
            elif params.action == "deleteResource":
                if not params.id:
                    return ToolError(
                        message="deleteResource needs `id` (e.g. skill:code-review).",
                        brief="Missing id",
                    )
                plan = plan_delete_resource(index, params.id)
            elif params.action == "removeEdge":
                if not params.source or not params.target:
                    return ToolError(
                        message="removeEdge needs both `source` and `target` resource ids.",
                        brief="Missing source/target",
                    )
                plan = plan_remove_edge(index, params.source, params.target, params.edge_type)
            elif params.action == "createResource":
                if not params.kind or not params.name:
                    return ToolError(
                        message="createResource needs both `kind` and `name`.",
                        brief="Missing kind/name",
                    )
                creatable = ", ".join(k.value for k in CREATABLE_KINDS)
                try:
                    kind = ResourceKind(params.kind)
                except ValueError:
                    return ToolError(
                        message=f"Unknown kind {params.kind!r}. Creatable kinds: {creatable}.",
                        brief="Unknown kind",
                    )
                if kind not in CREATABLE_KINDS:
                    return ToolError(
                        message=f"{kind.value} cannot be scaffolded. Creatable kinds: {creatable}.",
                        brief="Not creatable",
                    )
                plan = plan_create_resource(index, kind, params.name)
            else:  # createEdge
                if not params.source or not params.target:
                    return ToolError(
                        message="createEdge needs both `source` and `target` resource ids.",
                        brief="Missing source/target",
                    )
                plan = plan_create_edge(index, params.source, params.target, params.edge_type)
        except PlanError as exc:
            return ToolError(message=exc.message, brief=exc.code)

        plan_dict = plan.to_dict()
        lines = [plan.summary]
        lines += [f"  {op.op} {op.path}" for op in plan.operations]
        lines += [f"  edge {e['from']} {e['type']} {e['to']}" for e in plan.edges_added]

        return ToolReturnValue(
            is_error=False,
            output="\n".join(lines),
            message=(
                "Drafted a change plan. It is shown to the user to review and apply; "
                "you cannot apply it yourself."
            ),
            display=[BriefDisplayBlock(text=plan.summary)],
            extras=cast("dict[str, JsonType]", {"blueprintPlan": plan_dict}),
        )
