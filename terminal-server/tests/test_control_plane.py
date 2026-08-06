import json

import httpx
import pytest
from sanad_terminal.control_plane import ControlPlaneClient, ControlPlaneError

OK_BODY = {
    "data": {
        "sessionToken": "sess_abc",
        "userId": "user_1",
        "orgId": "personal_user_1",
        "email": "a@b.test",
        "displayName": "A B",
    },
    "meta": {"requestId": "rid"},
}


def make_client(handler) -> ControlPlaneClient:
    return ControlPlaneClient("https://cp.test", "s3cret", transport=httpx.MockTransport(handler))


async def test_redeem_success_sends_secret_and_parses_camel_case():
    seen: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["path"] = request.url.path
        seen["secret"] = request.headers.get("x-terminal-secret", "")
        seen["body"] = request.content.decode()
        return httpx.Response(200, json=OK_BODY)

    client = make_client(handler)
    identity = await client.redeem_ticket("tt_x")
    await client.aclose()

    assert seen["path"] == "/api/v1/terminal/redeem"
    assert seen["secret"] == "s3cret"
    assert json.loads(seen["body"]) == {"ticket": "tt_x"}
    assert identity.session_token == "sess_abc"
    assert identity.user_id == "user_1"
    assert identity.org_id == "personal_user_1"
    assert identity.email == "a@b.test"
    assert identity.display_name == "A B"


@pytest.mark.parametrize(
    ("status", "expected_code"),
    [
        (404, "invalid_ticket"),
        (409, "invalid_ticket"),
        (410, "ticket_expired"),
        (500, "redeem_failed"),
        (401, "redeem_failed"),
    ],
)
async def test_redeem_error_mapping(status: int, expected_code: str):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            status,
            json={"error": {"code": "x", "message": "y", "requestId": "r", "retryable": False}},
        )

    client = make_client(handler)
    with pytest.raises(ControlPlaneError) as excinfo:
        await client.redeem_ticket("tt_x")
    await client.aclose()
    assert excinfo.value.code == expected_code
    assert excinfo.value.status == status


async def test_malformed_success_body_is_redeem_failed():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"data": {"nope": True}})

    client = make_client(handler)
    with pytest.raises(ControlPlaneError) as excinfo:
        await client.redeem_ticket("tt_x")
    await client.aclose()
    assert excinfo.value.code == "redeem_failed"


async def test_transport_error_is_redeem_failed():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("boom")

    client = make_client(handler)
    with pytest.raises(ControlPlaneError) as excinfo:
        await client.redeem_ticket("tt_x")
    await client.aclose()
    assert excinfo.value.code == "redeem_failed"
