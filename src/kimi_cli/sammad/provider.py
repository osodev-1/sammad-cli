"""Wire a minted runtime token into kimi-cli's provider/model config.

The gateway is OpenAI-compatible, so ``openai_legacy`` is the provider type; the
runtime token is the API key and the gateway URL is the base URL. Model
configuration is server-authored (from the mint response) — the CLI invents
nothing (ADR-014).
"""

from __future__ import annotations

from pydantic import SecretStr

from kimi_cli.config import LLMModel, LLMProvider
from kimi_cli.sammad.models import MintResponse, ModelSettings

PROVIDER_NAME = "sammad-gateway"

# sammad model-capability names -> kimi ModelCapability names. "tool_use" is
# inherent in kimi and is not a ModelCapability, so it is dropped.
_CAPABILITY_MAP = {"thinking": "thinking"}


def build_provider(mint: MintResponse) -> LLMProvider:
    return LLMProvider(
        type="openai_legacy",
        base_url=mint.gateway_base_url,
        api_key=SecretStr(mint.token),
    )


def build_model(settings: ModelSettings, *, provider_name: str = PROVIDER_NAME) -> LLMModel:
    """Build one ``LLMModel`` for a single alias from its server-authored settings."""
    caps = {_CAPABILITY_MAP[c] for c in settings.capabilities if c in _CAPABILITY_MAP} or None
    return LLMModel(
        provider=provider_name,
        model=settings.name,
        max_context_size=settings.max_context_size,
        capabilities=caps,
        display_name=settings.name,
    )
