"""IdleStopper probe semantics: a truthy probe holds the machine exactly like
a live PTY session; a crashing probe fails SAFE (machine stays up)."""

import asyncio
from typing import cast

import pytest
from sanad_terminal.idle import IdleStopper
from sanad_terminal.manager import SessionManager


class _FakeManager:
    def __init__(self, count: int = 0) -> None:
        self.count = count


def _stopper(manager: _FakeManager) -> tuple[IdleStopper, asyncio.Event]:
    # IdleStopper only ever reads `.count` off the manager (see idle.py); the
    # fake provides exactly that. Cast rather than subclass SessionManager so
    # the test double stays a minimal, dependency-free stand-in.
    stopper = IdleStopper(cast(SessionManager, manager), idle_stop_seconds=0.05, tick_seconds=0.01)
    stopped = asyncio.Event()
    stopper._stop_machine = stopped.set  # type: ignore[method-assign]
    return stopper, stopped


@pytest.mark.asyncio
async def test_stops_when_nothing_holds():
    stopper, stopped = _stopper(_FakeManager(count=0))
    stopper.start()
    try:
        await asyncio.wait_for(stopped.wait(), timeout=2.0)
    finally:
        await stopper.stop()


@pytest.mark.asyncio
async def test_truthy_probe_holds_the_machine():
    stopper, stopped = _stopper(_FakeManager(count=0))
    stopper.add_probe(lambda: True)
    stopper.start()
    try:
        await asyncio.sleep(0.3)  # several idle windows
        assert not stopped.is_set()
    finally:
        await stopper.stop()


@pytest.mark.asyncio
async def test_probe_release_lets_it_stop():
    holding = {"on": True}
    stopper, stopped = _stopper(_FakeManager(count=0))
    stopper.add_probe(lambda: holding["on"])
    stopper.start()
    try:
        await asyncio.sleep(0.2)
        assert not stopped.is_set()
        holding["on"] = False
        await asyncio.wait_for(stopped.wait(), timeout=2.0)
    finally:
        await stopper.stop()


@pytest.mark.asyncio
async def test_crashing_probe_fails_safe():
    def boom() -> bool:
        raise RuntimeError("probe bug")

    stopper, stopped = _stopper(_FakeManager(count=0))
    stopper.add_probe(boom)
    stopper.start()
    try:
        await asyncio.sleep(0.3)
        assert not stopped.is_set()  # never kill a machine because a probe broke
    finally:
        await stopper.stop()
