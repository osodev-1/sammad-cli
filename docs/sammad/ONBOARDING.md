# sammad — onboarding

sammad is a governed, SSO-first coding agent. It is a fork of Kimi Code CLI that
signs you in with your organization identity and routes every model call through
an internal, Azure AI Foundry-backed gateway — so you never hold a personal
provider key. This guide gets you from a clone to a governed session.

## Prerequisites

- **Python 3.14** (pinned via `.python-version`). Earlier builds pinned 3.12 to
  dodge a pydantic `ForwardRef` bug that a 3.14 pre-release tripped on import;
  that is resolved in the current dependency pins, and the toolchain (including
  the pyright target) now tracks 3.14 — `uv` picks it up from `.python-version`.
- [`uv`](https://docs.astral.sh/uv/) for environment + dependency management.
- An **OS keychain**: macOS Keychain, Windows Credential Manager, or a Secret
  Service provider (e.g. GNOME Keyring) on Linux. sammad stores its session
  token only there — there is no plaintext fallback by design.
- The sammad **control plane** URL for your organization (the governance backend
  that brokers SSO and mints runtime tokens).

## Install

```bash
git clone <this-fork> sammad-cli && cd sammad-cli
uv venv          # uses the pinned 3.14 from .python-version
uv sync
```

This installs the `sammad` console script into the environment
(`.venv/bin/sammad`).

## Configure

Point the CLI at your control plane (defaults to `http://127.0.0.1:3001` for
local development):

```bash
export SAMMAD_API_BASE_URL="https://<your-control-plane>"
# optional: export SAMMAD_REQUEST_TIMEOUT=30
```

## Try it locally (no real backend, no keychain)

To kick the tyres without a control plane or an OS keychain, use the bundled
sandbox. It runs a tiny local stand-in for the control plane + gateway
(`scripts/demo_backend.py`) and points the CLI at it with a throwaway file
keychain:

```bash
scripts/sammad-demo login                     # auto-approves; stores a demo token
scripts/sammad-demo whoami
scripts/sammad-demo doctor
scripts/sammad-demo run                        # interactive governed agent
scripts/sammad-demo run -p "say hello" --print # one-shot
```

The model replies are canned — this proves the SSO login, runtime-token mint,
provider wiring, and streaming end to end. It is a **sandbox only**: it does no
real auth and writes the token to a plaintext file under `.demo-keyring/`. The
real CLI (below) uses a real control plane and a real OS keychain.

## Sign in

```bash
sammad login
```

This runs the Microsoft Entra **device authorization grant** brokered by the
control plane. Open the printed URL, enter the code, and approve. On success the
opaque session token is written to your OS keychain (never to disk in
plaintext). Check your identity anytime:

```bash
sammad whoami
```

## Run a governed session

```bash
sammad run                      # interactive
sammad run -p "fix the build"   # one-shot; args after `run` pass through to the agent
```

`sammad run` mints a short-lived runtime token, writes the gateway provider
config (an OpenAI-compatible endpoint whose model alias resolves to a Foundry
deployment server-side), keeps that token alive in place while you work, and
launches the agent. It also disables upstream telemetry and auto-update so a
governed session never egresses to or updates from Moonshot.

## Sign out

```bash
sammad logout   # revokes the session server-side and clears the local credential
```

## Diagnose

```bash
sammad doctor   # checks keychain, control-plane URL, and whether your session is valid
sammad about    # version + upstream (Kimi Code CLI) provenance
```

## Troubleshooting

- **`No OS keychain is available`** — unlock or install a keychain/Secret Service
  provider and retry. On a headless Linux box, start a Secret Service daemon
  (e.g. `gnome-keyring-daemon --unlock`) or run where one is available; sammad
  will not fall back to storing the token in plaintext.
- **`You are not signed in`** — run `sammad login`. If it persists, `sammad
  doctor` will show whether the control plane is reachable at
  `SAMMAD_API_BASE_URL`.
- **Sign-in timed out** — the device code expired before approval; just run
  `sammad login` again.
