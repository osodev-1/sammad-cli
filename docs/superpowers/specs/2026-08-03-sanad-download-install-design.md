# sanad — Download & Install (Design Spec)

**Status:** DRAFT for review · **Spec 4 of 4** · 2026-08-03
**Depends on:** the published `sanad` package (this CLI repo) + the `/download` page shell
(Spec #1's web surface).
**Stack:** static install scripts served by the Vercel app + a package registry.

> **Decisions to confirm (defaults picked):**
> 1. **Distribution channel** (default): publish `sanad` to **PyPI (public)**, install via
>    `uv tool install sanad`. ← alternatives: a private index (`--index-url`), or standalone
>    binaries (PyInstaller) if you want zero-Python installs. PyPI+uv is by far the least work.
> 2. **Bootstrap** (default): the installer installs **uv**, which then pulls the correct
>    **Python 3.14** automatically — the user never installs Python by hand.
> 3. **Windows:** PowerShell script (bash isn't native on Windows).

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
2. `uv tool install sanad` — uv resolves + fetches Python 3.14 and installs the `sanad`
   console script onto the user's PATH (`~/.local/bin`).
3. Print next steps: "✓ Installed. Run: `sanad login`".
4. Detect if `~/.local/bin` isn't on PATH and tell the user how to add it.

`install.ps1` mirrors this: install uv via `irm https://astral.sh/uv/install.ps1 | iex`, then
`uv tool install sanad`, then the same guidance.

*(uv is the right bootstrap because the CLI already targets Python 3.14 and uv installs the
interpreter itself — see the CLI's ONBOARDING.)*

## 4. The `/download` page

- Auto-detect OS → show the relevant one-liner first, with a **copy button**.
- Show both platforms + a manual fallback (`uv tool install sanad`, or `pipx install sanad`).
- Link to docs and to `sanad login`.
- (Optional) a "verify" line showing the expected `sanad --version`.

## 5. Publishing (release flow for this CLI repo)
- Build with `uv build`; publish with `uv publish` (or `twine`) to PyPI on tagged releases.
- The package name `sanad` must be available/claimed on PyPI. Version = `constant.VERSION`.
- CI: on a version tag, build + publish; the install URLs then serve the new version with no
  change (uv always installs latest).

## 6. Security
- Serve install scripts over HTTPS only; consider publishing a checksum + a
  `curl … | sh`-skeptic-friendly "read it first" note (link to the raw script).
- Do **not** auto-run `sanad login` inside the installer without consent — print the command
  and let the user run it (a login triggers a browser + keychain write).

## 7. Testing
- Run `install.sh` in a clean `ubuntu` and `debian` container and a fresh macOS shell →
  assert `sanad --version` works and `sanad login` is on PATH.
- Run `install.ps1` in a clean Windows PowerShell → same.
- A smoke check that both routes return the script with the right content-type.

## 8. Open questions
- PyPI (public) vs private index — do you want `sanad` publicly `pip install`-able?
- Standalone binaries (no Python at all) later, for locked-down enterprise machines?
- Auto-update: the CLI's upstream auto-update is disabled (governed); do you want a
  `sanad upgrade` that runs `uv tool upgrade sanad`?
