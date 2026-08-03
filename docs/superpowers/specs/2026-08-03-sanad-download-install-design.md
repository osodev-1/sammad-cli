# sanad — Download & Install (Design Spec)

**Status:** DRAFT for review · **Spec 4 of 4** · 2026-08-03
**Depends on:** the published `sanad` package (this CLI repo) + the `/download` page shell
(Spec #1's web surface).
**Stack:** static install scripts served by the Vercel app + a package registry.

> **Decisions (locked 2026-08-03):** distribution = **private index** — `sanad` is published
> to a private PyPI-compatible index (`SANAD_INDEX_URL`), **not** public PyPI, so it isn't
> `pip install`-able by the world. The install script (served from sanadcode.com) carries a
> **read-only index token** so the copy-paste one-liner still works. Bootstrap = **uv**
> (installs uv → the right Python 3.14). Windows = PowerShell. `sanad upgrade` deferred.

## 1. Purpose

Make "get sanad" a single copy-paste line on any OS, with no manual Python/uv setup, landing
the user at `sanad login`.

## 2. The one-liners (hosted at sanadcode.com)

- **macOS / Linux:** `curl -fsSL https://sanadcode.com/install.sh | sh`
- **Windows (PowerShell):** `irm https://sanadcode.com/install.ps1 | iex`

Both are static routes served by the Vercel app (`app/install.sh/route.ts` returning
`text/x-shellscript`; `app/install.ps1/route.ts` returning `text/plain`), so the URL is stable
and versionless (always latest).

## 3. What the scripts do

`install.sh` (POSIX sh):
1. If `uv` is missing → install it: `curl -LsSf https://astral.sh/uv/install.sh | sh`.
2. `uv tool install sanad --default-index "$SANAD_INDEX_URL"` — installs from the private
   index (the served script sets `SANAD_INDEX_URL`, which embeds the read token); uv resolves
   + fetches Python 3.14 and puts the `sanad` console script on PATH (`~/.local/bin`).
3. Print next steps: "✓ Installed. Run: `sanad login`".
4. Detect if `~/.local/bin` isn't on PATH and tell the user how to add it.

`install.ps1` mirrors this: install uv via `irm https://astral.sh/uv/install.ps1 | iex`, then
`uv tool install sanad --default-index $env:SANAD_INDEX_URL`, then the same guidance.

*(uv is the right bootstrap because the CLI already targets Python 3.14 and uv installs the
interpreter itself — see the CLI's ONBOARDING.)*

## 4. The `/download` page

- Auto-detect OS → show the relevant one-liner first, with a **copy button**.
- Show both platforms + a manual fallback (`uv tool install sanad`, or `pipx install sanad`).
- Link to docs and to `sanad login`.
- (Optional) a "verify" line showing the expected `sanad --version`.

## 5. Publishing (release flow for this CLI repo)
- Build with `uv build`; publish with `uv publish --publish-url "$SANAD_PUBLISH_URL"` (the
  private index's upload endpoint) on tagged releases. Version = `constant.VERSION`.
- CI: on a version tag, build + publish to the private index; the install URLs then serve the
  new version with no change (uv always installs latest from `SANAD_INDEX_URL`).

## 6. Security
- Serve install scripts over HTTPS only; consider publishing a checksum + a
  `curl … | sh`-skeptic-friendly "read it first" note (link to the raw script).
- Do **not** auto-run `sanad login` inside the installer without consent — print the command
  and let the user run it (a login triggers a browser + keychain write).
- The private-index **read token** baked into the served install script is effectively public
  (anyone can fetch the script) — use a **read-only, rotatable** token scoped to pulling the
  `sanad` package. The goal is keeping `sanad` off public PyPI / `pip` search, not perfect
  secrecy; per-user index auth would break the frictionless one-liner.

## 7. Testing
- Run `install.sh` in a clean `ubuntu` and `debian` container and a fresh macOS shell →
  assert `sanad --version` works and `sanad login` is on PATH.
- Run `install.ps1` in a clean Windows PowerShell → same.
- A smoke check that both routes return the script with the right content-type.

## 8. Open questions / deferred
- Which private index to host on (self-hosted devpi · Azure Artifacts · GCP Artifact Registry
  · Gemfury · AWS CodeArtifact) — an ops choice; the spec only assumes a PyPI-compatible
  `SANAD_INDEX_URL` + upload endpoint.
- Standalone binaries (no Python at all) for locked-down enterprise machines — later.
- `sanad upgrade` (thin `uv tool upgrade sanad` wrapper) — deferred to post-launch.
