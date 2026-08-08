import { and, count, eq, gte, sql, sum } from "drizzle-orm";
import { db } from "@/lib/db";
import { usageEvents } from "@/lib/db/schema";

export interface UsageDay {
  day: string; // "YYYY-MM-DD" (UTC)
  requests: number;
  tokensIn: number;
  tokensOut: number;
}

/** A UTC "YYYY-MM-DD" for a millisecond timestamp. */
function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Fill a sparse set of daily rows into `days` continuous UTC days ending today,
 * so a chart has no gaps. Pure — the DB query feeds it; unit-testable in node.
 */
export function fillDailySeries(
  rows: UsageDay[],
  days: number,
  nowMs: number,
): UsageDay[] {
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const out: UsageDay[] = [];
  // Anchor to UTC midnight so day boundaries are stable.
  const todayMidnight = Date.parse(`${utcDay(nowMs)}T00:00:00Z`);
  for (let i = days - 1; i >= 0; i--) {
    const day = utcDay(todayMidnight - i * 86_400_000);
    out.push(byDay.get(day) ?? { day, requests: 0, tokensIn: 0, tokensOut: 0 });
  }
  return out;
}

/**
 * Daily usage for an org over the last `days` days (UTC), gap-filled. Mirrors
 * getOrgUsage's source (usage_events) so the page and the meter never disagree.
 */
export async function getUsageTimeSeries(
  orgId: string,
  days = 30,
): Promise<UsageDay[]> {
  const sinceMs = Date.now() - days * 86_400_000;
  const bucket = sql<string>`to_char((${usageEvents.createdAt} at time zone 'UTC'), 'YYYY-MM-DD')`;
  const rows = await db
    .select({
      day: bucket,
      requests: count(usageEvents.id),
      tokensIn: sum(usageEvents.tokensIn),
      tokensOut: sum(usageEvents.tokensOut),
    })
    .from(usageEvents)
    .where(
      and(
        eq(usageEvents.orgId, orgId),
        gte(usageEvents.createdAt, new Date(sinceMs)),
      ),
    )
    .groupBy(bucket);

  const normalized: UsageDay[] = rows.map((r) => ({
    day: r.day,
    requests: Number(r.requests ?? 0),
    tokensIn: Number(r.tokensIn ?? 0),
    tokensOut: Number(r.tokensOut ?? 0),
  }));
  return fillDailySeries(normalized, days, Date.now());
}
