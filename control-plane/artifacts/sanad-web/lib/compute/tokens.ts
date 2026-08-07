/**
 * Derived per-run machine credentials — nothing secret at rest.
 *
 * AGENTD_TOKEN = base64url(HMAC-SHA256(TERMINAL_MACHINE_KEY, userId + ":" + runNonce))
 *
 * The token is injected into the task's env at RunTask; sanad-web recomputes
 * it for every proxied call and for redeem verification. Compromise of one
 * machine yields a credential scoped to that machine's own user; rotation =
 * rotate the key (or just restart the task — the nonce changes every run).
 */
import { createHmac, timingSafeEqual, createHash } from "crypto";

export function machineKey(): string {
  const key = process.env.TERMINAL_MACHINE_KEY ?? "";
  if (!key) throw new Error("TERMINAL_MACHINE_KEY is not configured");
  return key;
}

export function deriveMachineToken(userId: string, runNonce: string): string {
  return createHmac("sha256", machineKey())
    .update(`${userId}:${runNonce}`)
    .digest("base64url");
}

export function machineTokenMatches(
  presented: string,
  userId: string,
  runNonce: string
): boolean {
  const expected = deriveMachineToken(userId, runNonce);
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Public routing label: sha256(userId) truncated — no PII in hostnames. */
export function workspaceHash(userId: string): string {
  return createHash("sha256").update(userId).digest("hex").slice(0, 12);
}

/**
 * Per-session routing label. The migrated "main" session keeps the legacy
 * per-user hash (stored, never recomputed) — this formula only names sessions
 * created after the session-manager epic.
 */
export function sessionHash(userId: string, sessionId: string): string {
  return createHash("sha256").update(`${userId}:${sessionId}`).digest("hex").slice(0, 12);
}
