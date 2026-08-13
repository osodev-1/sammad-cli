"""Task 13: DX-4 parity e2e — `sanad agent dev` (local) and the RunRunner
route (cloud) must run the SAME scripted bundle through the SAME real CLI
and produce the SAME output document.

Fixture shape and spawn_argv follow the binding notes in the task brief:
- agent.yaml is the loadable nested `version: '1'` + `agent: {...}` form
  (kimi_cli.agentspec.load_agent_spec silently treats a flat document as an
  empty spec — see tests/worker/test_assembly.py::_agent_with_tools and
  tests_e2e/test_worker_dev.py's AGENT_YAML).
- The cloud path spawns via RunRunner with `cwd=dirs.workspace` (a tmp dir)
  and a from-scratch child env (`build_child_env`), so a bare `uv run kimi`
  would fail to resolve this repo's project from that cwd — spawn_argv uses
  `uv run --project <repo_root> kimi` (routes_worker.py appends
  `--wire --session ... --agent-file ... --work-dir ...` itself). The
  scripted-echo scripts path rides the CONFIG FILE (provider.env, applied
  inside the child by `create_llm`), not the parent env, so `--config-file`
  is baked into spawn_argv.
- The cloud control-plane and trace-upload transports are mocked (same
  pattern as terminal-server/tests/test_routes_worker.py's `_make_client`) so
  this test never makes a real network call.
- A successful cloud run has its run directory removed (`shutil.rmtree` in
  routes_worker.py's `_on_finished`, once status == "succeeded"), so the
  output is read from the mocked completion POST body, not from disk.
"""

from __future__ import annotations

import json
import subprocess
import time
from pathlib import Path

import httpx
from fastapi.testclient import TestClient

from tests_e2e.wire_helpers import (
    make_env,
    make_home_dir,
    make_work_dir,
    repo_root,
    write_scripted_config,
)

# Loadable nested shape required by kimi_cli.agentspec.load_agent_spec (see
# tests/worker/test_assembly.py::_agent_with_tools and
# tests_e2e/test_worker_dev.py's AGENT_YAML) — a flat top-level document is
# silently treated as an empty spec and fails later with a confusing error.
# `tools: []` is required too (Inherit() with no base to inherit from raises
# "Tools are required").
BUNDLE = {
    "agent.yaml": "version: '1'\nagent:\n  name: t\n  system_prompt_path: prompt.md\n  tools: []\n",
    "prompt.md": "You are a worker.",
    "worker.yaml": "interface:\n  inputs: {q: string}\n  outputs: {answer: string}\n",
}
SCRIPTS = [
    "\n".join(
        [
            "text: thinking",
            "tool_call: "
            + json.dumps(
                {
                    "id": "tc-1",
                    "name": "ReturnOutput",
                    "arguments": json.dumps({"output": {"answer": "42"}}),
                }
            ),
        ]
    )
]


def _dev_output(tmp_path: Path) -> dict:
    dev_dir = tmp_path / "dev"
    dev_dir.mkdir()
    config_path = write_scripted_config(dev_dir, SCRIPTS)
    work_dir = make_work_dir(dev_dir)
    home_dir = make_home_dir(dev_dir)
    for name, text in BUNDLE.items():
        (work_dir / name).write_text(text)
    proc = subprocess.run(
        [
            "uv",
            "run",
            "kimi",
            "agent",
            "dev",
            "--input",
            '{"q": "meaning"}',
            "--config-file",
            str(config_path),
            "--work-dir",
            str(work_dir),
        ],
        cwd=repo_root(),
        env=make_env(home_dir),
        capture_output=True,
        text=True,
        timeout=180,
    )
    assert proc.returncode == 0, proc.stderr
    return json.loads(proc.stdout.strip())


def _control_plane(calls: list[tuple[str, dict]]):
    """Mock transport for the completion POST — mirrors
    test_routes_worker.py's `_control_plane`. NEVER let the cloud path make
    a real network call; the run's output is read back from here since a
    successful run's directory is removed on disk (Task 12)."""
    from sanad_terminal.control_plane import ControlPlaneClient

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content) if request.content else {}
        calls.append((str(request.url), body))
        return httpx.Response(200, json={"data": {}})

    return ControlPlaneClient("https://cp.test", "unused", transport=httpx.MockTransport(handler))


def _upload_transport() -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text="ok")

    return httpx.MockTransport(handler)


def _cloud_output(tmp_path: Path) -> tuple[dict, list[str], list[dict]]:
    from sanad_terminal.app import create_app
    from sanad_terminal.settings import TerminalSettings

    cloud = tmp_path / "cloud"
    cloud.mkdir()
    config_path = write_scripted_config(cloud, SCRIPTS)
    settings = TerminalSettings(
        mode="task",
        fixed_user="u1",
        agentd_token="tok",
        data_dir=cloud,
        # `uv run kimi` alone would resolve to whatever project owns the
        # child's cwd (RunRunner spawns with cwd=dirs.workspace, a tmp dir
        # with no pyproject.toml) — `--project` pins the real repo. Routes
        # appends `--wire --session ... --agent-file ... --work-dir ...`, so
        # this is deliberately the base command *without* `--wire`, plus the
        # scripted-echo config file (the child env is built from scratch, so
        # KIMI_SCRIPTED_ECHO_SCRIPTS must ride the config, not the parent env).
        spawn_argv=(
            "uv",
            "run",
            "--project",
            str(repo_root()),
            "kimi",
            "--config-file",
            str(config_path),
        ),
        worker_enabled=True,
    )
    control_plane_calls: list[tuple[str, dict]] = []
    with TestClient(
        create_app(settings, _control_plane(control_plane_calls), _upload_transport())
    ) as c:
        body = {
            "runId": "r_dddddddddddd",
            "sendId": "r_dddddddddddd",
            "input": {"q": "meaning"},
            "bundle": {"files": BUNDLE},
            "budgets": {"maxTurnSeconds": 120, "maxStepsPerTurn": 50, "maxTokensPerRun": 100000},
            "sessionToken": "sess_x",
            "traceUploadUrl": "https://invalid.test/put",
        }
        r = c.post("/internal/worker/runs", json=body, headers={"authorization": "Bearer tok"})
        assert r.status_code == 200, r.text
        items = [json.loads(line) for line in r.text.strip().splitlines()]

        # `on_finished` (report + drop) fires as a background task AFTER the
        # StreamingResponse above already ended, same as
        # test_routes_worker.py's completion tests — wait for the completion
        # POST to actually land instead of racing it.
        from sanad_terminal.run_runner import get_run

        for _ in range(200):
            if get_run("r_dddddddddddd") is None:
                break
            time.sleep(0.05)
        else:
            raise AssertionError("cloud run was never de-registered after completion")

    events = [i["event"]["type"] for i in items if i["kind"] == "event"]
    completions = [call for call in control_plane_calls if "/complete" in call[0]]
    assert len(completions) == 1, control_plane_calls
    payload = completions[0][1]
    assert payload["status"] == "succeeded", payload
    return payload["output"], events, items


def test_dev_and_cloud_agree(tmp_path: Path) -> None:
    dev_out = _dev_output(tmp_path)
    cloud_out, cloud_events, cloud_items = _cloud_output(tmp_path)
    # INVARIANT (may not be weakened): same output document from both paths.
    assert dev_out == cloud_out == {"answer": "42"}

    # Event-sequence parity is checked at the cloud-journal level only: dev
    # (`kimi agent dev`) prints just the final output JSON on stdout, it
    # doesn't expose per-event wire journal — see this file's module
    # docstring / task report for why full sequence-level dev/cloud diffing
    # was out of scope for the P0 bar. Sanity-check the cloud journal saw a
    # full turn: begin, the tool call, and a terminated end item.
    assert "TurnBegin" in cloud_events, cloud_events
    assert any(t in ("ToolCall", "ToolCallPart") for t in cloud_events), cloud_events
    end_items = [i for i in cloud_items if i["kind"] in ("end", "error")]
    assert end_items, cloud_items
    assert end_items[-1].get("status") == "finished", end_items[-1]
