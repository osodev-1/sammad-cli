from kimi_cli.sanad.models import MintResponse
from kimi_cli.sanad.provider import build_model, build_provider

MINT = MintResponse.model_validate(
    {
        "token": "rtok-plain",
        "tokenId": "rtok_1",
        "familyId": "rtfam_1",
        "expiresAt": "2026-07-23T00:10:00Z",
        "absoluteExpiresAt": "2026-07-24T00:00:00Z",
        "gatewayBaseUrl": "http://gw.test/v1",
        "modelSettings": [
            {
                "name": "kimi-k2.7-code",
                "maxContextSize": 128000,
                "capabilities": ["thinking", "tool_use"],
            }
        ],
        "defaultModelAlias": "kimi-k2.7-code",
    }
)


def test_build_provider_is_openai_compatible_with_token_as_key():
    p = build_provider(MINT)
    assert p.type == "openai_legacy"
    assert p.base_url == "http://gw.test/v1"
    assert p.api_key.get_secret_value() == "rtok-plain"


def test_build_model_maps_capabilities_and_context():
    # build_model takes a single per-alias ModelSettings, not the whole mint.
    m = build_model(MINT.model_settings[0])
    assert m.model == "kimi-k2.7-code"
    assert m.max_context_size == 128000
    # "thinking" maps through; "tool_use" is dropped (inherent, not a capability).
    assert m.capabilities == {"thinking"}
    assert m.provider == "sanad-gateway"
