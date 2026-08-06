import { timingSafeEqual } from "crypto";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { ok, err } from "@/lib/http/envelope";
import { db } from "@/lib/db";
import { workspaceTasks } from "@/lib/db/schema";

function secretMatches(header: string | null): boolean {
  const secret = process.env.ROUTER_SHARED_SECRET;
  if (!secret || !header) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Router-facing: hash12 → the workspace task's private IP. The router caches
 * for ~30s and purges on connect failure, so a restarted task (new IP)
 * self-heals within one retry.
 */
export async function GET(req: NextRequest) {
  if (!process.env.ROUTER_SHARED_SECRET) {
    return err(503, "compute_unavailable", "Compute routing is not configured");
  }
  if (!secretMatches(req.headers.get("x-router-secret"))) {
    return err(401, "unauthorized", "Invalid router credential");
  }
  const hash = req.nextUrl.searchParams.get("hash") ?? "";
  if (!/^[a-f0-9]{12}$/.test(hash)) {
    return err(400, "invalid_request", "Malformed workspace hash");
  }
  const [row] = await db
    .select()
    .from(workspaceTasks)
    .where(eq(workspaceTasks.hash12, hash))
    .limit(1);
  if (!row?.taskIp) return err(404, "not_found", "Workspace is not running");
  return ok({ taskIp: row.taskIp });
}
