/**
 * Coder-panel access gate (P0 — ships dark; P1's /api/coder/* proxies enforce it).
 *
 * `SANAD_CODER_PANEL_EMAILS` is a comma-separated allowlist, SEPARATE from
 * `SANAD_TERMINAL_EMAILS` so write-capable coder access is grantable to a
 * strict subset of workspace users. Like the terminal gate it FAILS CLOSED:
 * empty or unset means nobody — the coder agent runs shell and file writes
 * server-side, so access is opt-in per person.
 */
export function coderPanelEmails(): string[] {
  return (process.env.SANAD_CODER_PANEL_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/** True if this email may use the coder panel. Empty allowlist denies all. */
export function isCoderPanelAllowed(email: string | null | undefined): boolean {
  if (!email) return false;
  return coderPanelEmails().includes(email.trim().toLowerCase());
}
