/**
 * Web-terminal access gate (dogfood v1).
 *
 * `SANAD_TERMINAL_EMAILS` is a comma-separated allowlist of user emails that
 * may open the browser workspace. Unlike the comp allowlist (lib/billing/
 * comp.ts) this gate FAILS CLOSED: an empty or unset list means nobody — the
 * workspace runs arbitrary agent workloads server-side, so access is opt-in
 * per person until per-user isolation hardens.
 */
export function terminalEmails(): string[] {
  return (process.env.SANAD_TERMINAL_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/** True if this email may open a web terminal. Empty allowlist denies all. */
export function isTerminalAllowed(email: string | null | undefined): boolean {
  if (!email) return false;
  return terminalEmails().includes(email.trim().toLowerCase());
}
