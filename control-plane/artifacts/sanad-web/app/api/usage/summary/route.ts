import { auth } from "@clerk/nextjs/server";
import { ok, err } from "@/lib/http/envelope";
import { getOrgUsage } from "@/lib/billing/quota";

/**
 * Clerk-authed compact usage summary for the workspace usage dock (US-001..006).
 * Reads the same getOrgUsage aggregate the dashboard meters and the quota gate
 * use, scoped to the signed-in user's personal org — matching the workspace
 * page's plan chip so the two never disagree.
 *
 * This is a pure control-plane DB read; it never touches the session machine,
 * so the dock may poll it freely without the liveness-follower discipline the
 * snapshot/graph/architect channels observe.
 */
export async function GET() {
  const { userId } = await auth();
  if (!userId) return err(401, "unauthorized", "Sign in to view usage");

  const usage = await getOrgUsage(`personal_${userId}`);
  return ok({
    plan: usage.plan,
    level: usage.status.level,
    isExceeded: usage.status.isExceeded,
    requests: usage.status.requests,
    tokens: usage.status.tokens,
    periodEnd: usage.currentPeriodEnd?.toISOString() ?? null,
  });
}
