import { timingSafeEqual } from "crypto";
import { NextRequest } from "next/server";
import { z } from "zod";
import { ok, err } from "@/lib/http/envelope";
import { redeemTerminalTicket } from "@/lib/auth/terminal-tickets";

const Body = z.object({ ticket: z.string().min(1).max(256) });

/** Timing-safe comparison against the shared service secret. */
function secretMatches(header: string | null): boolean {
  const secret = process.env.TERMINAL_SHARED_SECRET;
  if (!secret || !header) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Server-to-server: the terminal service exchanges a one-time ticket for the
 * CLI session token it will inject into the spawned agent. Gated by
 * X-Terminal-Secret — this route is never called by browsers.
 */
export async function POST(req: NextRequest) {
  if (!process.env.TERMINAL_SHARED_SECRET) {
    return err(503, "terminal_unavailable", "Terminal redeem is not configured");
  }
  if (!secretMatches(req.headers.get("x-terminal-secret"))) {
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

  return ok({
    sessionToken: result.sessionToken,
    userId: result.userId,
    orgId: result.orgId,
    email: result.email,
    displayName: result.displayName,
  });
}
