import { timingSafeEqual } from "crypto";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { z } from "zod";
import { ok, err } from "@/lib/http/envelope";
import { redeemTerminalTicket } from "@/lib/auth/terminal-tickets";
import { db } from "@/lib/db";
import { workspaceSessions, workspaceTasks } from "@/lib/db/schema";
import { machineTokenMatches } from "@/lib/compute/tokens";

const Body = z.object({ ticket: z.string().min(1).max(256) });

/** Timing-safe comparison against the shared service secret (railway mode). */
function secretMatches(header: string | null): boolean {
  const secret = process.env.TERMINAL_SHARED_SECRET;
  if (!secret || !header) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

type Caller =
  | { kind: "legacy" }
  | { kind: "machine"; userId: string }
  | { kind: "unauthorized" };

/**
 * Who is redeeming? Either the legacy shared-secret service, or a workspace
 * machine presenting its derived credential (token + nonce). For machines we
 * resolve WHICH user's machine via the nonce and verify the HMAC — and later
 * require the ticket to belong to that same user, so a stolen ticket can
 * never be redeemed through someone else's machine.
 */
async function identifyCaller(req: NextRequest): Promise<Caller> {
  const machineToken = req.headers.get("x-machine-token");
  const machineNonce = req.headers.get("x-machine-nonce");
  if (machineToken && machineNonce) {
    // Session machines own nonces now; the legacy per-user table covers any
    // machine born before the session-manager migration. Missing the sessions
    // table here is exactly the bug that 401'd every post-migration machine.
    const [sessionRow] = await db
      .select({ userId: workspaceSessions.userId })
      .from(workspaceSessions)
      .where(eq(workspaceSessions.runNonce, machineNonce))
      .limit(1);
    let ownerId = sessionRow?.userId;
    if (!ownerId) {
      const [legacyRow] = await db
        .select({ userId: workspaceTasks.userId })
        .from(workspaceTasks)
        .where(eq(workspaceTasks.runNonce, machineNonce))
        .limit(1);
      ownerId = legacyRow?.userId;
    }
    if (!ownerId) return { kind: "unauthorized" };
    try {
      if (!machineTokenMatches(machineToken, ownerId, machineNonce)) {
        return { kind: "unauthorized" };
      }
    } catch {
      return { kind: "unauthorized" }; // TERMINAL_MACHINE_KEY unset
    }
    return { kind: "machine", userId: ownerId };
  }
  if (secretMatches(req.headers.get("x-terminal-secret"))) {
    return { kind: "legacy" };
  }
  return { kind: "unauthorized" };
}

export async function POST(req: NextRequest) {
  if (!process.env.TERMINAL_SHARED_SECRET && !process.env.TERMINAL_MACHINE_KEY) {
    return err(503, "terminal_unavailable", "Terminal redeem is not configured");
  }

  const caller = await identifyCaller(req);
  if (caller.kind === "unauthorized") {
    return err(401, "unauthorized", "Invalid terminal service credential");
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return err(400, "invalid_request", "Request body must be JSON");
  }
  const parsed = Body.safeParse(body);
  if (!parsed.success) {
    return err(400, "invalid_request", "Missing ticket");
  }

  const result = await redeemTerminalTicket(parsed.data.ticket);
  if (!result.ok) {
    if (result.reason === "not_found") {
      return err(404, "not_found", "Ticket not found");
    }
    if (result.reason === "expired") {
      return err(410, "ticket_expired", "Ticket has expired");
    }
    return err(409, "conflict", "Ticket already redeemed");
  }

  // Cross-user enforcement: a machine may only redeem its own user's tickets.
  // (The ticket is burned either way — an attacker gains nothing but a log line.)
  if (caller.kind === "machine" && result.userId !== caller.userId) {
    console.error("cross-user redeem blocked", {
      machineUser: caller.userId,
      ticketUser: result.userId,
    });
    return err(403, "forbidden", "Ticket does not belong to this workspace");
  }

  return ok({
    sessionToken: result.sessionToken,
    userId: result.userId,
    orgId: result.orgId,
    email: result.email,
    displayName: result.displayName,
  });
}
