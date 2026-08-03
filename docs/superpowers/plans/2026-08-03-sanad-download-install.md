# sanad Download & Install — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use `- [ ]` checkboxes.
>
> **Where this runs:** TWO repos. **(A)** the Next.js/Vercel app (plans #1/#2) — serves the install scripts + `/download` page. **(B)** the **sanad CLI repo** (this repo, `sammad-cli`) — the private-index publish workflow. Implements **Spec #4** — `2026-08-03-sanad-download-install-design.md`.

**Goal:** Make "get sanad" a single copy-paste line on macOS/Linux/Windows, with no manual Python or uv setup, landing the user at `sanad login`.

**Architecture:** `sanad` is published to a **private PyPI-compatible index**; the installer installs **uv** (which pulls the right Python 3.14 itself) then `uv tool install sanad --default-index "$SANAD_INDEX_URL"`. `sanadcode.com` serves stable, versionless `install.sh` / `install.ps1` routes (each carrying a read-only index token) + a `/download` page.

**Tech Stack:** Vercel route handlers (return raw scripts) · Next.js page · GitHub Actions + `uv build`/`uv publish` in the CLI repo.

## Global Constraints
- **Distribution = private index (`SANAD_INDEX_URL`), install via uv.** `sanad` is published to a private PyPI-compatible index, not public PyPI; the served install script carries a read-only index token so the one-liner still works. Version = the CLI's `constant.VERSION`.
- Install one-liners are **stable + versionless** (always latest): `curl -fsSL https://sanadcode.com/install.sh | sh` and (PowerShell) `irm https://sanadcode.com/install.ps1 | iex`.
- Scripts served over **HTTPS**, correct content-types; installer **must not** auto-run `sanad login` (it opens a browser + writes the keychain — needs consent).
- The CLI already disables upstream auto-update; any updater is an explicit `sanad`/uv action.

## File Structure
```
# (A) Vercel app:
app/install.sh/route.ts       # returns the POSIX sh installer
app/install.ps1/route.ts      # returns the PowerShell installer
app/download/page.tsx         # OS-detect + copy buttons + manual fallback
# (B) CLI repo (this repo):
.github/workflows/release.yml # uv build + uv publish on version tag
```

---

### Task 1 (Vercel): `install.sh` route

**Files:** Create `app/install.sh/route.ts`; Test `tests/contract/install-routes.test.ts`

- [ ] **Step 1: Failing test** — `GET /install.sh` returns `200`, `content-type: text/x-shellscript`, and a body containing `uv tool install sanad`.
- [ ] **Step 2: Run → fail. Step 3: Implement** — return this script as text:

```sh
#!/bin/sh
set -e
# Served from sanadcode.com with a read-only index token baked in:
SANAD_INDEX_URL="https://<READ_TOKEN>@pkgs.sanadcode.com/simple/"
if ! command -v uv >/dev/null 2>&1; then
  echo "· installing uv (Python toolchain manager) …"
  curl -LsSf https://astral.sh/uv/install.sh | sh
  export PATH="$HOME/.local/bin:$PATH"
fi
echo "· installing sanad …"
uv tool install sanad --default-index "$SANAD_INDEX_URL"
echo ""
echo "✓ sanad installed. Next:  sanad login"
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *)
  echo "  (add \$HOME/.local/bin to your PATH if 'sanad' isn't found)" ;;
esac
```

Route: `export const GET = () => new Response(SCRIPT, { headers: { "content-type": "text/x-shellscript" } });`

- [ ] **Step 4: Run → pass. Commit:** `feat(install): install.sh route`.

### Task 2 (Vercel): `install.ps1` route

**Files:** Create `app/install.ps1/route.ts`; extend the contract test

- [ ] **Step 1: Failing test** — `GET /install.ps1` returns `200`, `content-type: text/plain`, body containing `uv tool install sanad`.
- [ ] **Step 2: Run → fail. Step 3: Implement** — return:

```powershell
$env:SANAD_INDEX_URL = "https://<READ_TOKEN>@pkgs.sanadcode.com/simple/"
if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
  Write-Host "· installing uv ..."
  irm https://astral.sh/uv/install.ps1 | iex
}
Write-Host "· installing sanad ..."
uv tool install sanad --default-index $env:SANAD_INDEX_URL
Write-Host "`n> sanad installed. Next:  sanad login"
```

- [ ] **Step 4: Run → pass. Commit:** `feat(install): install.ps1 route`.

### Task 3 (Vercel): `/download` page

**Files:** Create `app/download/page.tsx`

- [ ] **Step 1:** Detect OS from the `User-Agent` (server) or `navigator` (client); show the matching one-liner first with a **copy button**; show the other platform below.
- [ ] **Step 2:** Add a manual fallback block (`uv tool install sanad`, or `pipx install sanad`) + a "verify: `sanad --version`" line + a link to docs and to `sanad login`.
- [ ] **Step 3: Commit:** `feat(download): /download page with copy-paste installers`.

### Task 4 (CLI repo): private-index release workflow

**Files:** Create `.github/workflows/release.yml` in **this** repo; verify `pyproject.toml` has the `sanad` package metadata + `[project.scripts] sanad = ...` (already present).

- [ ] **Step 1:** Confirm build works locally: `UV_PYTHON=3.12 uv build` (sdist + wheel) — actually use the repo's pinned Python (3.14): `uv build`. Inspect `dist/`.
- [ ] **Step 2: Workflow** — on a `v*` tag: checkout, `astral-sh/setup-uv`, `uv build`, `uv publish` to the **private index** with `SANAD_PUBLISH_URL` + `SANAD_INDEX_TOKEN` (repo secrets). Guard: only publish if the tag matches `constant.VERSION`.

```yaml
name: release
on: { push: { tags: ["v*"] } }
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: astral-sh/setup-uv@v5
      - run: uv build
      - run: uv publish --publish-url ${{ secrets.SANAD_PUBLISH_URL }} --token ${{ secrets.SANAD_INDEX_TOKEN }}
```

- [ ] **Step 3: Commit:** `ci(release): build + publish sanad to the private index on tag` (authored as Omar, per this repo's rule).

### Task 5: install E2E

**Files:** `README`/docs note in the Vercel repo

- [ ] **Step 1:** In a clean `ubuntu` container: `curl -fsSL <preview>/install.sh | sh` → assert `sanad --version` works and prints the sanad banner. Repeat on macOS + a Windows PowerShell (`irm <preview>/install.ps1 | iex`).
- [ ] **Step 2:** Smoke-test both routes return the scripts with the right content-types.
- [ ] **Step 3: Commit:** `test(install): clean-machine install verification`.

## Self-Review
- **Spec coverage:** §2 one-liners → Tasks 1,2; §3 script behavior → 1,2; §4 `/download` → 3;
  §5 publishing → 4; §6 security (HTTPS, no auto-login) → constraints + 1,2; §7 testing → 5.
- **Placeholders:** the scripts are complete (no "add install logic here"); the publish job is
  concrete. Open questions from the spec (private index, standalone binaries, `sanad upgrade`)
  are **out of scope** for this plan and left for a follow-up.
- **Cross-repo note:** Tasks 1–3,5 land in the Vercel repo; Task 4 lands in the CLI repo
  (`sammad-cli`) and must follow its Omar-only commit rule.
