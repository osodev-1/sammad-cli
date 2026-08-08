import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { organizations } from "@/lib/db/schema";
import { getOrgUsage } from "@/lib/billing/quota";
import { getUsageTimeSeries } from "@/lib/billing/usage-series";
import UsageClient from "./UsageClient";

/**
 * The Usage page (S8): the org's current-period allowance meters, a 30-day
 * daily trend, and a per-model breakdown — all from the same usage_events
 * source getOrgUsage reads, so the page and the gate never disagree.
 */
export default async function UsagePage() {
  const { userId } = await auth();
  if (!userId) redirect("/");

  const orgId = `personal_${userId}`;
  const [org] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  const usage = await getOrgUsage(orgId);
  const series = await getUsageTimeSeries(orgId, 30);

  return (
    <UsageClient
      orgName={org?.name ?? "My workspace"}
      plan={usage.plan}
      usage={usage.status}
      periodEnd={usage.currentPeriodEnd?.toISOString() ?? null}
      byModel={usage.byModel}
      series={series}
    />
  );
}
