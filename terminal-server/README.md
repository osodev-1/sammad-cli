# sanad-terminal

The workspace service behind the browser workspace at www.sanadcode.com/terminal.

Two surfaces, one mounted volume:

- **WebSocket PTY bridge** (`/ws`) — redeems a one-time terminal ticket against
  the control plane, spawns the governed `sanad run` agent in a PTY inside the
  user's persistent workspace, and relays raw bytes to xterm.js in the browser.
- **Internal workspace REST** (`/internal/workspace/*`) — file tree, read/write,
  upload, archive, move, delete, search. Called only by the sanad-web proxy with
  the shared service secret; never by browsers.

Per-user layout on the volume:

```
/data/users/<userId>/
  workspace/    # agent cwd + file API root (the ONLY exposed directory)
  home/         # $HOME for the agent process
  kimi-share/   # $KIMI_SHARE_DIR (config.toml, sessions) — never exposed
```

Run locally: `uv run sanad-terminal` (needs `TERMINAL_SHARED_SECRET`; see
`src/sanad_terminal/settings.py` for all env vars). Tests:
`uv run pytest terminal-server/tests`.
