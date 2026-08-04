import { NextRequest } from "next/server";
import { z } from "zod";
import { ok, err } from "@/lib/http/envelope";
import { db } from "@/lib/db";
import { usageEvents } from "@/lib/db/schema";
import { verifyRuntimeBearer } from "@/lib/tokens/runtime";
import { verifyBearer } from "@/lib/auth/session";
import { getOrgUsage } from "@/lib/billing/quota";

/**
 * Usage READ — the `sanad usage` command. Session-authed (the CLI holds an
 * opaque *session* token, not a runtime token), it returns the current-period
 * summary in the CLI's frozen shape:
 *   { used, limit, periodEnd, byModel:[{ alias, requests, tokensIn, tokensOut }] }
 * where `used`/`limit` are request counts. Coexists on this path with the POST
 * ingest below, which the gateway calls with a *runtime* token.
 */
export async function GET(req: NextRequest) {
  const session = await verifyBearer(req);
  if (!session) {
    return err(401, "unauthorized", "Invalid or revoked session token");
  }

  const usage = await getOrgUsage(session.orgId);
  return ok({
    used: usage.status.requests.used,
    limit: usage.status.requests.limit,
    periodEnd: usage.currentPeriodEnd
      ? usage.currentPeriodEnd.toISOString()
      : null,
    byModel: usage.byModel,
  });
}

/**
 * Usage ingest. The gateway calls this after serving a model request, using
 * the runtime token it just validated — that token is what identifies the org.
 *
 * Deliberately NOT quota-gated: an org that has blown through its allowance
 * must still have its overage recorded, or the meter would freeze at the limit
 * and we'd lose the record of what was actually consumed. Enforcement happens
 * where access is granted (runtime-token mint/renew), not where it's reported.
 */

/**
 * Storage id for a usage event.
 *
 * The caller-supplied idempotency key is namespaced by org. `usage_events.id`
 * is a GLOBAL primary key, so storing a bare eventId would let one tenant's
 * key collide with another's — `onConflictDoNothing` would then silently
 * discard a legitimate event and under-bill that org. Keys only ever need to
 * be unique within the org that sent them.
 */
function usageEventId(orgId: string, eventId?: string): string {
  return eventId ? `${orgId}:${eventId}` : crypto.randomUUID();
}

const Body = z.object({
  modelAlias: z.string().min(1).max(128),
  tokensIn: z.number().int().min(0).max(100_000_000),
  tokensOut: z.number().int().min(0).max(100_000_000),
  /** Micro-cents. Optional — not every deployment prices per call. */
  cost: z.number().int().min(0).optional(),
  /**
   * Caller-supplied idempotency key. Gateways retry, and a retried report
   * must not bill the org twice; a repeat of the same id is a no-op.
   */
  eventId: z.string().min(1).max(128).optional(),
});

export async function POST(req: NextRequest) {
  const runtime = await verifyRuntimeBearer(req);
  if (!runtime) {
    return err(401, "unauthorized", "Invalid, expired or revoked runtime token");
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return err(400, "invalid_request", "Request body must be JSON");
  }

  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    return err(
      400,
      "invalid_request",
      parsed.error.issues[0]?.message ?? "Invalid usage payload"
    );
  }
  const { modelAlias, tokensIn, tokensOut, cost, eventId } = parsed.data;

  try {
    await db
      .insert(usageEvents)
      .values({
        id: usageEventId(runtime.orgId, eventId),
        orgId: runtime.orgId,
        userId: runtime.userId,
        cliSessionId: runtime.cliSessionId,
        modelAlias,
        tokensIn,
        tokensOut,
        cost: cost ?? 0,
      })
      .onConflictDoNothing({ target: usageEvents.id });

    // Echo the post-write balance so the gateway can stop early on the next
    // call instead of waiting to be refused at the next token renewal.
    const { status } = await getOrgUsage(runtime.orgId);

    return ok({
      recorded: true,
      level: status.level,
      exceeded: status.isExceeded,
      requests: {
        used: status.requests.used,
        limit: status.requests.limit,
        remaining: status.requests.remaining,
      },
      tokens: {
        used: status.tokens.used,
        limit: status.tokens.limit,
        remaining: status.tokens.remaining,
      },
    });
  } catch (e) {
    console.error("usage ingest error", e);
    return err(500, "internal_error", "Failed to record usage", true);
  }
}
