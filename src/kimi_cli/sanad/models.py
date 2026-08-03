"""Typed models for the sanad control-plane responses.

Fields are snake_case; the backend speaks camelCase, so an alias generator maps
them. Every response is parsed from ``unknown`` via ``model_validate``.
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel


class _Camel(BaseModel):
    model_config = ConfigDict(populate_by_name=True, alias_generator=to_camel, extra="ignore")


class DeviceStart(_Camel):
    device_auth_id: str
    user_code: str
    verification_uri: str
    verification_uri_complete: str | None = None
    expires_at: str
    poll_interval_seconds: int


class LoginUser(_Camel):
    id: str
    email: str
    display_name: str | None = None


class LoginOrganization(_Camel):
    id: str
    name: str
    slug: str


class LoginMembership(_Camel):
    id: str
    role: str


class DevicePoll(_Camel):
    status: str  # "pending" | "complete"
    cli_session_token: str | None = None
    user: LoginUser | None = None
    organization: LoginOrganization | None = None
    membership: LoginMembership | None = None


class Me(_Camel):
    user_id: str
    organization_id: str
    membership_id: str
    role: str
    permissions: list[str] = []


class ModelSettings(_Camel):
    name: str
    max_context_size: int
    capabilities: list[str] = []


class MintResponse(_Camel):
    token: str
    token_id: str
    family_id: str
    expires_at: str
    absolute_expires_at: str
    gateway_base_url: str
    # One entry per allowed alias; the ``name`` fields enumerate the aliases the
    # user may select. ``default_model_alias`` names which one ``sanad run``
    # starts on and must match one of the entries' ``name``.
    model_settings: list[ModelSettings]
    default_model_alias: str


class UsageByModel(_Camel):
    alias: str
    requests: int = 0
    tokens_in: int = 0
    tokens_out: int = 0


class UsageSummary(_Camel):
    """Current-period usage against the org's plan quota (requests-based)."""

    used: int
    limit: int
    period_end: str | None = None
    by_model: list[UsageByModel] = []
