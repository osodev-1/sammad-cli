"""End-to-end against the live sanad backend (the `pnpm demo` stack).

Gated on SANAD_DEMO_API_BASE_URL so it never runs in normal CI. Proves the
full client path — device flow, session, runtime-token mint, a streamed turn
through the gateway, and revoke/logout — against real services.
"""

from __future__ import annotations

import os
import re

import httpx
import pytest

from kimi_cli.sanad.client import SanadClient
from kimi_cli.sanad.errors import SanadError
from kimi_cli.sanad.provider import build_model, build_provider
from kimi_cli.sanad.settings import SanadSettings

API = os.environ.get("SANAD_DEMO_API_BASE_URL")
pytestmark = pytest.mark.skipif(not API, reason="SANAD_DEMO_API_BASE_URL not set")


def test_full_flow_against_demo_backend():
    client = SanadClient(SanadSettings(api_base_url=API))

    # device flow — the demo IdP auto-approves
    start = client.device_start()
    assert start.user_code
    result = client.poll_until_complete(start, sleep=lambda _s: None)
    assert result.status == "complete"
    token = result.cli_session_token
    assert token

    # session identity
    me = client.me(token)
    assert me.role == "owner"

    # mint a runtime token and build the kimi provider/model from it
    mint = client.mint_runtime_token(token)
    aliases = {s.name for s in mint.model_settings}
    assert mint.default_model_alias in aliases
    default_settings = next(s for s in mint.model_settings if s.name == mint.default_model_alias)
    provider = build_provider(mint)
    model = build_model(default_settings)
    assert provider.type == "openai_legacy"
    assert model.max_context_size > 0

    # a real streamed turn straight through the gateway using that config
    with httpx.Client() as raw:
        resp = raw.post(
            provider.base_url.rstrip("/") + "/chat/completions",
            headers={"authorization": f"Bearer {provider.api_key.get_secret_value()}"},
            json={
                "model": model.model,
                "stream": True,
                "messages": [{"role": "user", "content": "hello from the sanad fork"}],
            },
            timeout=15,
        )
    assert resp.status_code == 200
    body = resp.text
    assert "[DONE]" in body
    # Text arrives as streamed deltas; reassemble before asserting.
    content = "".join(re.findall(r'"content":"([^"]*)"', body))
    assert content == "Hello from the fake provider."

    # revoke + logout close everything
    client.revoke_runtime_token_family(token, mint.family_id)
    client.logout(token)
    with pytest.raises(SanadError):
        client.me(token)
