"""Seed an empty ``.sanad`` blueprint when a project has none.

Every project workspace should start with a blueprint so the graph and the
Architect have something to stand on (the user reported the Architect saying
"no .sanad"). This writes a minimal Project manifest at
``<workspace>/.sanad/sanad.yaml`` if — and only if — one does not already exist,
so it is safe to call on every machine boot. The user/Architect grows the
blueprint from there (agents, skills, …).
"""

from __future__ import annotations

from pathlib import Path

# A minimal, valid Project envelope (kernel ProjectSpec fields all default).
_PROJECT_MANIFEST = """\
apiVersion: sanad.dev/v1alpha1
kind: Project
metadata:
  id: project:workspace
  name: Workspace
spec:
  projectType: unknown
"""


def ensure_blueprint(workspace_root: Path) -> bool:
    """Scaffold ``.sanad`` in the layout the Kimi CLI understands.

    Writes ``.sanad/sanad.yaml`` (the Project) only if absent, and ensures a
    ``.sanad/skills`` directory — which is exactly where the CLI's skill loader
    looks for a project's skills (``<workspace>/.sanad/skills/<slug>/SKILL.md``),
    so a skill authored in the blueprint is a real CLI skill at runtime. No
    ``.gitkeep`` (a stray file there would index as an unclassified node).

    Returns True if it created the manifest, False if one already existed.
    Idempotent — never overwrites an existing blueprint.
    """
    sanad = workspace_root / ".sanad"
    manifest = sanad / "sanad.yaml"
    created = not manifest.exists()
    sanad.mkdir(parents=True, exist_ok=True)
    (sanad / "skills").mkdir(exist_ok=True)  # the CLI's project skills brand dir
    if created:
        manifest.write_text(_PROJECT_MANIFEST, encoding="utf-8")
    return created
