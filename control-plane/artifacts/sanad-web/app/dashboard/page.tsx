import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { cliSessions, organizations } from "@/lib/db/schema";
import { and, eq, desc, isNull } from "drizzle-orm";
import { getOrgUsage } from "@/lib/billing/quota";
import DashboardClient from "./DashboardClient";

export default async function DashboardPage() {
  const { userId } = await auth();
  if (!userId) redirect("/");

  const orgId = `personal_${userId}`;

  const [org] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  // Active CLI sessions
  const sessions = await db
    .select()
    .from(cliSessions)
    .where(and(eq(cliSessions.userId, userId), isNull(cliSessions.revokedAt)))
    .orderBy(desc(cliSessions.createdAt))
    .limit(20);

  /*
   * Deliberately the same call the runtime-token gate makes, rather than a
   * parallel query shaped for display. If the dashboard computed usage its own
   * way, a user could be shown "healthy" while the API refused to mint tokens.
   */
  const usage = await getOrgUsage(orgId);

  return (
    <DashboardClient
      orgName={org?.name ?? "My workspace"}
      plan={usage.plan}
      usage={usage.status}
      hasStripeCustomer={usage.hasStripeCustomer}
      currentPeriodEnd={usage.currentPeriodEnd?.toISOString() ?? null}
      periodStart={usage.periodStart.toISOString()}
      usageByModel={usage.byModel}
      sessions={sessions.map((s) => ({
        id: s.id,
        deviceLabel: s.deviceLabel ?? "CLI Session",
        createdAt: s.createdAt.toISOString(),
        lastUsedAt: s.lastUsedAt?.toISOString() ?? null,
      }))}
    />
  );
}
