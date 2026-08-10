"""Session service: ties the control-plane client to the OS keychain.

This is the one place that owns the opaque CLI session token lifecycle
(ADR-016) and the in-place runtime-token renewal loop (ADR-017). Commands call
into it; it never prints — a caller-supplied callback surfaces the device-flow
prompt so the UI layer stays in :mod:`kimi_cli.sanad.cli`.
"""

from __future__ import annotations

import contextlib
import threading
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path

from kimi_cli.config import Config, save_config
from kimi_cli.sanad.client import SanadClient
from kimi_cli.sanad.errors import NotLoggedIn, SanadError
from kimi_cli.sanad.keychain import KeychainStore
from kimi_cli.sanad.models import DevicePoll, DeviceStart, Me, MintResponse, UsageSummary
from kimi_cli.sanad.provider import PROVIDER_NAME, build_model, build_provider
from kimi_cli.sanad.settings import SanadSettings


def _parse_iso(value: str) -> datetime:
    """Parse an ISO-8601 instant (accepting a trailing ``Z``) as tz-aware UTC."""
    dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=UTC)


class SanadSession:
    """Stateful facade over the client + keychain for one control plane."""

    def __init__(
        self,
        settings: SanadSettings | None = None,
        *,
        client: SanadClient | None = None,
        keychain: KeychainStore | None = None,
    ) -> None:
        self._settings = settings or SanadSettings.load()
        self._client = client or SanadClient(self._settings)
        self._keychain = keychain or KeychainStore(self._settings.api_base_url)

    # -- token storage ----------------------------------------------------
    def stored_token(self) -> str | None:
        return self._keychain.get()

    def require_token(self) -> str:
        token = self._keychain.get()
        if not token:
            raise NotLoggedIn()
        return token

    # -- auth -------------------------------------------------------------
    def login(
        self,
        *,
        on_prompt: Callable[[DeviceStart], None],
        sleep: Callable[[float], None] | None = None,
        now: Callable[[], float] | None = None,
    ) -> DevicePoll:
        """Run the device-authorization flow and persist the session token.

        ``on_prompt`` is invoked once with the verification URI/user code so the
        caller can tell the user where to approve.
        """
        start = self._client.device_start()
        on_prompt(start)
        kwargs: dict[str, object] = {}
        if sleep is not None:
            kwargs["sleep"] = sleep
        if now is not None:
            kwargs["now"] = now
        result = self._client.poll_until_complete(start, **kwargs)  # type: ignore[arg-type]
        if not result.cli_session_token:
            raise SanadError(
                "login_incomplete", "Sign-in completed without a session token.", status=502
            )
        self._keychain.set(result.cli_session_token)
        return result

    def whoami(self) -> Me:
        return self._client.me(self.require_token())

    def usage(self) -> UsageSummary:
        return self._client.usage(self.require_token())

    def logout(self) -> None:
        """Best-effort server-side logout, then clear the local token.

        The local credential is removed even if the server call fails, so a
        revoked or offline session never leaves a stale token on the machine.
        """
        token = self._keychain.get()
        if token:
            with contextlib.suppress(SanadError):
                self._client.logout(token)
        self._keychain.delete()

    # -- run configuration ------------------------------------------------
    def configure_run(
        self,
        config: Config,
        *,
        config_file: Path | None = None,
        provider_name: str = PROVIDER_NAME,
    ) -> MintResponse:
        """Mint a runtime token and write the gateway provider/models into ``config``.

        Every allowed alias from the mint response is registered as its own model
        entry (keyed by its alias name, all sharing the one gateway provider), so
        ``/model <alias>`` works in-session. ``default_model`` is pointed at the
        server-named ``default_model_alias``. Returns the mint response so the
        caller can start renewal.
        """
        mint = self._client.mint_runtime_token(self.require_token())
        config.providers[provider_name] = build_provider(mint)
        for settings in mint.model_settings:
            config.models[settings.name] = build_model(settings, provider_name=provider_name)
        config.default_model = mint.default_model_alias
        save_config(config, config_file)
        return mint

    def new_renewer(
        self,
        mint: MintResponse,
        *,
        on_exhausted: Callable[[], None] | None = None,
    ) -> RuntimeTokenRenewer:
        return RuntimeTokenRenewer(
            self._client, self.require_token(), mint, on_exhausted=on_exhausted
        )

    def close(self) -> None:
        self._client.close()


class RuntimeTokenRenewer:
    """Keeps a runtime token alive in place until its absolute expiry (ADR-017).

    Renewal extends the *same* token's expiry server-side, so the config written
    by :meth:`SanadSession.configure_run` never needs rewriting.
    """

    def __init__(
        self,
        client: SanadClient,
        session_token: str,
        mint: MintResponse,
        *,
        renew_skew_seconds: float = 120.0,
        min_sleep_seconds: float = 5.0,
        sleep: Callable[[float], None] | None = None,
        now: Callable[[], datetime] | None = None,
        on_error: Callable[[SanadError], None] | None = None,
        on_exhausted: Callable[[], None] | None = None,
    ) -> None:
        self._client = client
        self._session_token = session_token
        self._token_id = mint.token_id
        self._expires_at = _parse_iso(mint.expires_at)
        self._absolute_expires_at = _parse_iso(mint.absolute_expires_at)
        self._skew = renew_skew_seconds
        self._min_sleep = min_sleep_seconds
        self._now = now or (lambda: datetime.now(UTC))
        self._on_error = on_error
        # Fired when renewal ends for good WITHOUT stop() — session revoked
        # (non-retryable renew) or the 24h absolute cap. From here every LLM
        # call is a guaranteed 401: a headless runner should die (and be
        # respawned with fresh auth) rather than zombie on a dead token.
        self._on_exhausted = on_exhausted
        self._stop = threading.Event()
        self._sleep = sleep or self._stop.wait  # interruptible sleep by default
        self._thread: threading.Thread | None = None

    def seconds_until_renew(self) -> float:
        """Delay before the next renewal, clamped to ``[min_sleep, +inf)``."""
        due = (self._expires_at - self._now()).total_seconds() - self._skew
        return max(self._min_sleep, due)

    def renew_once(self) -> bool:
        """Renew now. Returns ``True`` while renewal should continue.

        Stops (returns ``False``) once the absolute cap is reached; on a
        transient error, reports it and keeps the loop alive to retry.
        """
        if self._now() >= self._absolute_expires_at:
            return False
        try:
            expires_at = self._client.renew_runtime_token(self._session_token, self._token_id)
            if expires_at:
                self._expires_at = _parse_iso(expires_at)
        except SanadError as exc:
            if self._on_error is not None:
                self._on_error(exc)
            if not exc.retryable:
                return False
        return self._now() < self._absolute_expires_at

    def _run(self) -> None:
        while not self._stop.is_set():
            self._sleep(self.seconds_until_renew())
            if self._stop.is_set():
                return
            if not self.renew_once():
                if self._on_exhausted is not None:
                    self._on_exhausted()
                return

    def start(self) -> None:
        if self._thread is not None:
            return
        self._thread = threading.Thread(target=self._run, name="sanad-token-renewer", daemon=True)
        self._thread.start()

    def stop(self, *, timeout: float = 5.0) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=timeout)
            self._thread = None
