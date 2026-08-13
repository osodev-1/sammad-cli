import json
import subprocess

from tests_e2e.wire_helpers import (
    make_env,
    make_home_dir,
    make_work_dir,
    repo_root,
    write_scripted_config,
)

# Loadable shape required by kimi_cli.agentspec.load_agent_spec: `version` + `agent:`
# nesting (see tests/worker/test_assembly.py::_agent_with_tools). A flat top-level
# `{name: ..., system_prompt_path: ...}` document is silently treated as an empty
# spec by `_load_agent_spec` (`AgentSpec(**data.get("agent", {}))`), which later
# fails with a confusing "Agent name is required" instead of loading. `tools` is
# also required on a non-extending spec (Inherit() with no base to inherit from
# raises "Tools are required"), so it must be listed explicitly, even if empty.
AGENT_YAML = "version: '1'\nagent:\n  name: t\n  system_prompt_path: prompt.md\n  tools: []\n"
WORKER_YAML = "interface:\n  inputs: {q: string}\n  outputs: {answer: string}\n"


def _tool_call(payload: dict) -> str:
    call = {"id": "tc-1", "name": "ReturnOutput", "arguments": json.dumps(payload)}
    return f"tool_call: {json.dumps(call)}"


def _run_dev(tmp_path, scripts: list[str], input_json: str) -> subprocess.CompletedProcess:
    config_path = write_scripted_config(tmp_path, scripts)
    work_dir = make_work_dir(tmp_path)
    home_dir = make_home_dir(tmp_path)
    (work_dir / "agent.yaml").write_text(AGENT_YAML)
    (work_dir / "prompt.md").write_text("You are a test agent.")
    (work_dir / "worker.yaml").write_text(WORKER_YAML)
    return subprocess.run(
        [
            "uv",
            "run",
            "kimi",
            "agent",
            "dev",
            "--input",
            input_json,
            "--config-file",
            str(config_path),
            "--work-dir",
            str(work_dir),
        ],
        cwd=repo_root(),
        env=make_env(home_dir),
        capture_output=True,
        text=True,
        timeout=120,
    )


def test_dev_returns_output(tmp_path) -> None:
    scripts = ["\n".join(["text: working", _tool_call({"output": {"answer": "42"}})])]
    proc = _run_dev(tmp_path, scripts, '{"q": "meaning"}')
    assert proc.returncode == 0, proc.stderr
    assert json.loads(proc.stdout.strip()) == {"answer": "42"}


def test_dev_no_output_exit_code(tmp_path) -> None:
    # Model never calls ReturnOutput: one text turn, then the nudge turn also returns text.
    proc = _run_dev(tmp_path, ["text: done", "text: still no tool"], '{"q": "x"}')
    assert proc.returncode == 3, (proc.stdout, proc.stderr)


def test_dev_bad_input_exit_code(tmp_path) -> None:
    proc = _run_dev(tmp_path, ["text: unused"], '{"wrong_key": 1}')
    assert proc.returncode == 4
