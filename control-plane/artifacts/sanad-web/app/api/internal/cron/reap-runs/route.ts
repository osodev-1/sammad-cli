import { timingSafeEqual } from "crypto";
import { NextRequest } from "next/server";
import { ok, err } from "@/lib/http/envelope";
import { DEFAULT_STALE_MS, sweepLostRuns } from "@/lib/runs/reaper";

// Floor for staleAfterMs — a caller-supplied 0 or negative value must not
// reap every currently-running run instantly.
const MIN_STALE_MS = 60_000;

function secretMatches(header: string | null): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret || !header) return false; // unset CRON_SECRET => always 401, fail closed
  const a = Buffer.from(header);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Cron entrypoint for the lost-run reaper — not session- or machine-authed,
 * just a shared secret the scheduler holds (same shape as
 * ROUTER_SHARED_SECRET's x-router-secret check in
 * app/api/v1/compute/route/route.ts).
 */
export async function POST(req: NextRequest) {
  if (!secretMatches(req.headers.get("x-cron-secret"))) {
    return err(401, "unauthorized", "Invalid cron credential");
  }

  const raw = (await req.json().catch(() => ({}))) as { staleAfterMs?: unknown };
  const requested = typeof raw.staleAfterMs === "number" ? raw.staleAfterMs : DEFAULT_STALE_MS;
  const staleAfterMs = Math.max(requested, MIN_STALE_MS);

  const reaped = await sweepLostRuns(staleAfterMs);
  return ok({ reaped });
}
