"""Opt-in smoke test against a REAL control plane + Azure AI Foundry gateway.

This is the production-shaped counterpart to ``test_integration.py`` (which runs
against the fake-IdP ``pnpm demo`` stack). Because a real Entra device login
cannot complete non-interactively, the tester supplies an already-obtained CLI
session token out of band:

    SAMMAD_SMOKE_API_BASE_URL=https://<control-plane> \
    SAMMAD_SMOKE_SESSION_TOKEN=<opaque session token from `sammad login`> \
        uv run pytest tests/sammad/test_smoke.py -v

It mints a real runtime token, builds the gateway provider/model exactly as the
CLI does, streams one real completion through the Foundry-backed gateway, then
revokes the token family. Skipped (and reported as skipped) whenever the two
variables are absent, so it never runs in normal CI and never spends model
budget by accident.
"""

from __future__ import annotations

import os
import re

import httpx
import pytest

from kimi_cli.sammad.client import SammadClient
from kimi_cli.sammad.provider import build_model, build_provider
from kimi_cli.sammad.settings import SammadSettings

API = os.environ.get("SAMMAD_SMOKE_API_BASE_URL")
SESSION_TOKEN = os.environ.get("SAMMAD_SMOKE_SESSION_TOKEN")

pytestmark = pytest.mark.skipif(
    not (API and SESSION_TOKEN),
    reason="set SAMMAD_SMOKE_API_BASE_URL and SAMMAD_SMOKE_SESSION_TOKEN to run the real smoke",
)


def test_mint_and_stream_through_real_foundry_gateway():
    client = SammadClient(SammadSettings(api_base_url=API))

    # The supplied session token must be valid (proves the control plane is reachable).
    me = client.me(SESSION_TOKEN)
    assert me.organization_id

    # Mint a real runtime token and build the kimi provider/model from it.
    mint = client.mint_runtime_token(SESSION_TOKEN)
    assert mint.token
    assert mint.gateway_base_url
    aliases = {s.name for s in mint.model_settings}
    assert mint.default_model_alias in aliases
    default_settings = next(s for s in mint.model_settings if s.name == mint.default_model_alias)
    provider = build_provider(mint)
    model = build_model(default_settings)
    assert provider.type == "openai_legacy"
    assert model.max_context_size > 0

    # One real streamed turn through the Foundry-backed gateway. The model output
    # is non-deterministic, so assert on structure, not exact text.
    try:
        with httpx.Client() as raw:
            resp = raw.post(
                provider.base_url.rstrip("/") + "/chat/completions",
                headers={"authorization": f"Bearer {provider.api_key.get_secret_value()}"},
                json={
                    "model": model.model,
                    "stream": True,
                    "max_tokens": 16,
                    "messages": [{"role": "user", "content": "Reply with the single word: ok"}],
                },
                timeout=60,
            )
        assert resp.status_code == 200, resp.text
        body = resp.text
        assert "[DONE]" in body
        content = "".join(re.findall(r'"content":"([^"]*)"', body))
        assert content.strip(), "expected a non-empty streamed completion"
    finally:
        # Always clean up the minted family, even if the assertion above fails.
        client.revoke_runtime_token_family(SESSION_TOKEN, mint.family_id)
