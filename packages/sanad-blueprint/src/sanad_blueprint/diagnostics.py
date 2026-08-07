"""Diagnostics — the three-severity validation results from PRD §15.

Every parse or validation failure becomes a Diagnostic attached to a node or
file. A malformed file is never dropped from the graph (NF-008); it appears as
an invalid node carrying its diagnostics.
"""

from __future__ import annotations

from enum import Enum

from pydantic import BaseModel


class Severity(str, Enum):
    # Resource cannot activate / a plan cannot apply when integrity would break.
    BLOCKING = "blocking"
    # May activate after explicit review; the risk is shown.
    WARNING = "warning"
    # Recommended improvement, no activation impact.
    INFO = "info"


class Diagnostic(BaseModel):
    severity: Severity
    # Stable machine code, e.g. "duplicate_id", "unresolved_reference".
    code: str
    message: str
    # Where it applies — a resource id and/or a repo-relative path. At least
    # one is always set so the UI can anchor the badge.
    resource_id: str | None = None
    path: str | None = None

    @classmethod
    def blocking(
        cls, code: str, message: str, *, resource_id: str | None = None, path: str | None = None
    ) -> Diagnostic:
        return cls(
            severity=Severity.BLOCKING,
            code=code,
            message=message,
            resource_id=resource_id,
            path=path,
        )

    @classmethod
    def warning(
        cls, code: str, message: str, *, resource_id: str | None = None, path: str | None = None
    ) -> Diagnostic:
        return cls(
            severity=Severity.WARNING,
            code=code,
            message=message,
            resource_id=resource_id,
            path=path,
        )

    @classmethod
    def info(
        cls, code: str, message: str, *, resource_id: str | None = None, path: str | None = None
    ) -> Diagnostic:
        return cls(
            severity=Severity.INFO,
            code=code,
            message=message,
            resource_id=resource_id,
            path=path,
        )
