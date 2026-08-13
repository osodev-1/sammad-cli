"""Resource scaffolds — the files a "New <Kind>" action creates.

Each template produces a minimal, schema-valid manifest (and any supporting
files) under a resource folder. Kept deliberately small; the user or Architect
Chat fills in the detail. Content is plain string formatting — no engine — so
the produced files are obvious in a diff.
"""

from __future__ import annotations

from dataclasses import dataclass

from .schemas import API_VERSION, KIND_ID_PREFIX, ResourceKind


@dataclass(frozen=True)
class TemplateFile:
    # Path relative to the resource folder, e.g. "agent.yaml" or "SKILL.md".
    rel: str
    content: str


@dataclass(frozen=True)
class Template:
    kind: ResourceKind
    # The folder each resource of this kind lives under, e.g. "agents".
    dir: str
    files: tuple[TemplateFile, ...]


def _manifest(kind: ResourceKind, rid: str, name: str, spec_body: str) -> str:
    return (
        f"apiVersion: {API_VERSION}\n"
        f"kind: {kind.value}\n"
        f"metadata:\n"
        f"  id: {rid}\n"
        f"  name: {name}\n"
        f"spec:\n{spec_body}"
    )


def render(kind: ResourceKind, rid: str, name: str) -> list[TemplateFile]:
    """The files for a new resource of `kind` with id `rid` and display `name`."""
    if kind == ResourceKind.AGENT:
        return [
            TemplateFile("agent.yaml", _manifest(kind, rid, name, "  prompt: prompt.md\n")),
            TemplateFile("prompt.md", f"# {name}\n\nDescribe this agent's role and behavior.\n"),
        ]
    if kind == ResourceKind.SKILL:
        # SKILL.md carries frontmatter so the Kimi CLI loads it as a real skill
        # at runtime (it reads <workspace>/.sanad/skills/<slug>/SKILL.md, keying
        # on the frontmatter name/description). `skill.yaml` is the blueprint's
        # view of the same skill; the two live side by side.
        slug = rid.split(":", 1)[1]
        skill_md = (
            f"---\n"
            f"name: {slug}\n"
            f"description: What this skill does and when the agent should use it.\n"
            f"---\n\n"
            f"# {name}\n\n"
            f"Operational instructions for this skill.\n"
        )
        return [
            TemplateFile("skill.yaml", _manifest(kind, rid, name, "  instructions: SKILL.md\n")),
            TemplateFile("SKILL.md", skill_md),
        ]
    if kind == ResourceKind.TOOL:
        return [
            TemplateFile(
                "tool.yaml",
                _manifest(
                    kind,
                    rid,
                    name,
                    "  handler:\n    type: builtin\n    name: workspace.files\n"
                    "  timeoutMs: 30000\n",
                ),
            )
        ]
    if kind == ResourceKind.MCP_SERVER:
        return [
            TemplateFile(
                "mcp.yaml",
                _manifest(
                    kind,
                    rid,
                    name,
                    "  transport: stdio\n  command: node\n  args: []\n"
                    "  activation:\n    trusted: false\n",
                ),
            )
        ]
    if kind == ResourceKind.HOOK:
        return [
            TemplateFile(
                "hook.yaml",
                _manifest(
                    kind,
                    rid,
                    name,
                    "  event: file.beforeWrite\n  targets: []\n"
                    "  execution:\n    timeoutMs: 5000\n    onFailure: block\n",
                ),
            )
        ]
    if kind == ResourceKind.POLICY:
        return [
            TemplateFile(
                "policy.yaml",
                _manifest(kind, rid, name, "  filesystem:\n    deny:\n      - '../**'\n"),
            )
        ]
    if kind == ResourceKind.WORKFLOW:
        return [
            TemplateFile(
                "workflow.yaml",
                _manifest(kind, rid, name, "  steps: []\n"),
            )
        ]
    if kind == ResourceKind.PROMPT:
        return [
            TemplateFile("prompt.yaml", _manifest(kind, rid, name, "  content: PROMPT.md\n")),
            TemplateFile("PROMPT.md", f"# {name}\n\nWrite the reusable prompt text here.\n"),
        ]
    if kind == ResourceKind.CONTEXT_DOCUMENT:
        return [
            TemplateFile("context.yaml", _manifest(kind, rid, name, "  source: CONTENT.md\n")),
            TemplateFile("CONTENT.md", f"# {name}\n\nBackground knowledge agents should read.\n"),
        ]
    # Fallback: a bare manifest with an empty spec.
    return [TemplateFile(f"{KIND_ID_PREFIX[kind]}.yaml", _manifest(kind, rid, name, "  {}\n"))]


# Kinds a user can scaffold from the UI (the connectable core; Evaluation,
# Template and PublishProfile stay read-only until their flows land — S10).
CREATABLE_KINDS: tuple[ResourceKind, ...] = (
    ResourceKind.AGENT,
    ResourceKind.SKILL,
    ResourceKind.TOOL,
    ResourceKind.MCP_SERVER,
    ResourceKind.HOOK,
    ResourceKind.POLICY,
    ResourceKind.WORKFLOW,
    ResourceKind.PROMPT,
    ResourceKind.CONTEXT_DOCUMENT,
)

KIND_DIR: dict[ResourceKind, str] = {
    ResourceKind.AGENT: "agents",
    ResourceKind.SKILL: "skills",
    ResourceKind.TOOL: "tools",
    ResourceKind.MCP_SERVER: "mcps",
    ResourceKind.HOOK: "hooks",
    ResourceKind.POLICY: "policies",
    ResourceKind.WORKFLOW: "workflows",
    ResourceKind.PROMPT: "prompts",
    ResourceKind.CONTEXT_DOCUMENT: "context",
    ResourceKind.EVALUATION: "evaluations",
}


def slugify(name: str) -> str:
    out = []
    prev_dash = False
    for ch in name.strip().lower():
        if ch.isalnum():
            out.append(ch)
            prev_dash = False
        elif not prev_dash:
            out.append("-")
            prev_dash = True
    return "".join(out).strip("-") or "untitled"
