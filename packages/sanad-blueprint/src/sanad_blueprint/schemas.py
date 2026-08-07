"""Resource schemas — one pydantic model per PRD kind (Appendix A shapes).

These models are the single source of truth. agentd validates against them and
exports ``model_json_schema()`` to the web UI for template forms and on-save
validation, so there is no second (zod) copy to drift.

Design notes:
- Every kind shares an envelope: apiVersion / kind / metadata / spec.
- ``spec`` models set ``extra="allow"`` — unknown fields are preserved, not
  rejected, so a manifest written for a newer schema still parses and renders
  (forward-lenient; validation surfaces the unknowns as info diagnostics
  elsewhere, never as a hard parse failure — NF-008).
- IDs are namespaced: ``kind_prefix:slug`` (e.g. ``agent:primary``).
"""

from __future__ import annotations

from enum import Enum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

API_VERSION = "sanad.dev/v1alpha1"

# Namespaced stable id: "<prefix>:<slug>", slug is kebab/alnum.
ID_PATTERN = r"^[a-z][a-z0-9]*:[a-z0-9][a-z0-9-]*$"


class ResourceKind(str, Enum):
    PROJECT = "Project"
    AGENT = "Agent"
    SKILL = "Skill"
    TOOL = "Tool"
    MCP_SERVER = "MCPServer"
    HOOK = "Hook"
    WORKFLOW = "Workflow"
    PROMPT = "Prompt"
    POLICY = "Policy"
    CONTEXT_DOCUMENT = "ContextDocument"
    EVALUATION = "Evaluation"
    TEMPLATE = "Template"
    PUBLISH_PROFILE = "PublishProfile"


class Metadata(BaseModel):
    model_config = ConfigDict(extra="allow")

    id: str = Field(pattern=ID_PATTERN)
    name: str
    description: str | None = None
    tags: list[str] = Field(default_factory=list)
    owner: str | None = None
    # Lifecycle: active | disabled | archived (free-form, validated softly).
    lifecycle: str | None = None


class _SpecBase(BaseModel):
    """Base for every kind's spec — unknown fields preserved, not rejected."""

    model_config = ConfigDict(extra="allow")


# --------------------------------------------------------------- specs ---


class ProjectSpec(_SpecBase):
    # application|service|static-site|library|agent-package|documentation|unknown
    projectType: str = "unknown"
    applicationRoot: str = "."
    entrypoints: dict[str, list[str]] = Field(default_factory=dict)  # {"agents": ["agent:primary"]}
    publishProfiles: list[str] = Field(default_factory=list)
    defaultPolicies: list[str] = Field(default_factory=list)
    validation: dict[str, Any] = Field(default_factory=dict)
    graph: dict[str, Any] = Field(default_factory=dict)


class AgentSpec(_SpecBase):
    prompt: str | None = None
    skills: list[str] = Field(default_factory=list)
    tools: list[str] = Field(default_factory=list)
    mcps: list[str] = Field(default_factory=list)
    policies: list[str] = Field(default_factory=list)
    context: list[str] = Field(default_factory=list)
    delegatesTo: list[str] = Field(default_factory=list)
    evaluations: list[str] = Field(default_factory=list)
    limits: dict[str, Any] = Field(default_factory=dict)


class SkillSpec(_SpecBase):
    instructions: str | None = None  # e.g. "SKILL.md"
    tools: list[str] = Field(default_factory=list)
    mcps: list[str] = Field(default_factory=list)
    policies: list[str] = Field(default_factory=list)
    inputs: dict[str, Any] = Field(default_factory=dict)
    outputs: dict[str, Any] = Field(default_factory=dict)


class ToolSpec(_SpecBase):
    handler: dict[str, Any] = Field(default_factory=dict)
    permissions: dict[str, Any] = Field(default_factory=dict)
    network: dict[str, Any] = Field(default_factory=dict)
    env: dict[str, str] = Field(default_factory=dict)
    approval: dict[str, Any] = Field(default_factory=dict)
    timeoutMs: int | None = None


class MCPServerSpec(_SpecBase):
    transport: str | None = None  # stdio|http|sse
    command: str | None = None
    args: list[str] = Field(default_factory=list)
    env: dict[str, str] = Field(default_factory=dict)
    expose: dict[str, Any] = Field(default_factory=dict)  # {allow:[...], deny:[...]}
    activation: dict[str, Any] = Field(default_factory=dict)  # {trusted: bool}


class HookSpec(_SpecBase):
    event: str | None = None
    targets: list[str] = Field(default_factory=list)
    conditions: dict[str, Any] = Field(default_factory=dict)
    handler: dict[str, Any] = Field(default_factory=dict)
    execution: dict[str, Any] = Field(default_factory=dict)
    policies: list[str] = Field(default_factory=list)


class WorkflowSpec(_SpecBase):
    inputs: dict[str, Any] = Field(default_factory=dict)
    outputs: dict[str, Any] = Field(default_factory=dict)
    steps: list[dict[str, Any]] = Field(default_factory=list)


class PromptSpec(_SpecBase):
    body: str | None = None  # inline or a file reference


class PolicySpec(_SpecBase):
    filesystem: dict[str, Any] = Field(default_factory=dict)
    network: dict[str, Any] = Field(default_factory=dict)
    commands: dict[str, Any] = Field(default_factory=dict)
    shell: dict[str, Any] = Field(default_factory=dict)
    publish: dict[str, Any] = Field(default_factory=dict)
    git: dict[str, Any] = Field(default_factory=dict)


class ContextDocumentSpec(_SpecBase):
    document: str | None = None  # markdown file reference


class EvaluationSpec(_SpecBase):
    targets: list[str] = Field(default_factory=list)
    scenarios: list[dict[str, Any]] = Field(default_factory=list)


class TemplateSpec(_SpecBase):
    produces: str | None = None  # which kind it scaffolds
    files: list[dict[str, Any]] = Field(default_factory=list)


class PublishProfileSpec(_SpecBase):
    projectRoot: str = "."
    environment: str | None = None
    provider: dict[str, Any] = Field(default_factory=dict)
    source: dict[str, Any] = Field(default_factory=dict)
    build: dict[str, Any] = Field(default_factory=dict)
    runtime: dict[str, Any] = Field(default_factory=dict)
    health: dict[str, Any] = Field(default_factory=dict)
    env: dict[str, str] = Field(default_factory=dict)
    approvals: dict[str, Any] = Field(default_factory=dict)
    rollback: dict[str, Any] = Field(default_factory=dict)


SPEC_MODELS: dict[ResourceKind, type[_SpecBase]] = {
    ResourceKind.PROJECT: ProjectSpec,
    ResourceKind.AGENT: AgentSpec,
    ResourceKind.SKILL: SkillSpec,
    ResourceKind.TOOL: ToolSpec,
    ResourceKind.MCP_SERVER: MCPServerSpec,
    ResourceKind.HOOK: HookSpec,
    ResourceKind.WORKFLOW: WorkflowSpec,
    ResourceKind.PROMPT: PromptSpec,
    ResourceKind.POLICY: PolicySpec,
    ResourceKind.CONTEXT_DOCUMENT: ContextDocumentSpec,
    ResourceKind.EVALUATION: EvaluationSpec,
    ResourceKind.TEMPLATE: TemplateSpec,
    ResourceKind.PUBLISH_PROFILE: PublishProfileSpec,
}

# The id prefix each kind uses, for validation and scaffolding.
KIND_ID_PREFIX: dict[ResourceKind, str] = {
    ResourceKind.PROJECT: "project",
    ResourceKind.AGENT: "agent",
    ResourceKind.SKILL: "skill",
    ResourceKind.TOOL: "tool",
    ResourceKind.MCP_SERVER: "mcp",
    ResourceKind.HOOK: "hook",
    ResourceKind.WORKFLOW: "workflow",
    ResourceKind.PROMPT: "prompt",
    ResourceKind.POLICY: "policy",
    ResourceKind.CONTEXT_DOCUMENT: "context",
    ResourceKind.EVALUATION: "evaluation",
    ResourceKind.TEMPLATE: "template",
    ResourceKind.PUBLISH_PROFILE: "publish",
}


class Resource(BaseModel):
    """The validated envelope + kind-specific spec of one manifest."""

    model_config = ConfigDict(extra="allow")

    apiVersion: str
    kind: ResourceKind
    metadata: Metadata
    spec: _SpecBase


# Public map used by the schema-export endpoint (kind name -> JSON Schema).
KIND_MODELS: dict[str, type[_SpecBase]] = {k.value: v for k, v in SPEC_MODELS.items()}


def json_schemas() -> dict[str, dict[str, Any]]:
    """JSON Schema per kind spec, for the web UI's forms and validation."""
    return {name: model.model_json_schema() for name, model in KIND_MODELS.items()}
