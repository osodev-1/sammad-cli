/**
 * One-time terminal tickets: the handoff between a Clerk-authenticated browser
 * and the terminal service.
 *
 * The browser never holds a CLI session token. `mintTerminalTicket` mints the
 * session server-side and parks its plaintext on a short-lived ticket row
 * (device_auth_requests.pending_session_token precedent); the terminal service
 * redeems the ticket exactly once over an authenticated server-to-server call
 * and receives the session token, after which the plaintext is cleared.
 */
import { and, eq, gt, isNull } from "drizzle-orm";
import { db } from "../db";
import { terminalTickets, users } from "../db/schema";
import { mintSession } from "./session";
import { hashToken, newToken } from "./tokens";

const TICKET_TTL_MS = 60_000;

export async function mintTerminalTicket(
  userId: string,
  orgId: string
): Promise<{ ticket: string; expiresIn: number }> {
  const sessionToken = await mintSession(userId, orgId, undefined, "Web terminal");
  const ticket = newToken("tt");
  await db.insert(terminalTickets).values({
    id: crypto.randomUUID(),
    ticketHash: hashToken(ticket),
    sessionToken,
    userId,
    orgId,
    expiresAt: new Date(Date.now() + TICKET_TTL_MS),
  });
  return { ticket, expiresIn: TICKET_TTL_MS / 1000 };
}

export type RedeemResult =
  | {
      ok: true;
      sessionToken: string;
      userId: string;
      orgId: string;
      email: string | null;
      displayName: string | null;
    }
  | { ok: false; reason: "not_found" | "expired" | "already_redeemed" };

export async function redeemTerminalTicket(ticket: string): Promise<RedeemResult> {
  const hash = hashToken(ticket);

  // Atomic one-time claim: only one concurrent caller passes redeemedAt IS
  // NULL. RETURNING yields post-update values — sessionToken is untouched by
  // this statement, so it is still present in `claimed`; a second UPDATE then
  // clears the plaintext.
  const [claimed] = await db
    .update(terminalTickets)
    .set({ redeemedAt: new Date() })
    .where(
      and(
        eq(terminalTickets.ticketHash, hash),
        isNull(terminalTickets.redeemedAt),
        gt(terminalTickets.expiresAt, new Date())
      )
    )
    .returning();

  if (!claimed) {
    const [row] = await db
      .select()
      .from(terminalTickets)
      .where(eq(terminalTickets.ticketHash, hash))
      .limit(1);
    if (!row) return { ok: false, reason: "not_found" };
    if (row.redeemedAt) return { ok: false, reason: "already_redeemed" };
    return { ok: false, reason: "expired" };
  }

  await db
    .update(terminalTickets)
    .set({ sessionToken: null })
    .where(eq(terminalTickets.id, claimed.id));

  if (!claimed.sessionToken) return { ok: false, reason: "already_redeemed" };

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, claimed.userId))
    .limit(1);

  return {
    ok: true,
    sessionToken: claimed.sessionToken,
    userId: claimed.userId,
    orgId: claimed.orgId,
    email: user?.email ?? null,
    displayName: user?.displayName ?? null,
  };
}
