import { NextRequest } from "next/server";
import { ok, err } from "@/lib/http/envelope";
import { verifyBearer } from "@/lib/auth/session";
import { getAgentByName } from "@/lib/agents/registry";
import { mintInvoke } from "@/lib/tokens/invoke";
import { EntitlementError } from "@/lib/tokens/runtime";
import { QuotaExceededError } from "@/lib/billing/quota";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const session = await verifyBearer(req);
  if (!session) {
    return err(401, "unauthorized", "Invalid or revoked session token");
  }

  const { name } = await params;
  const agent = await getAgentByName(session.orgId, name);
  if (!agent) {
    return err(404, "not_found", "No such agent");
  }

  const body = (await req.json().catch(() => null)) as { env?: string } | null;
  // mintInvoke itself has no runtime guard on env — validate here before
  // calling it, per the review finding carried over from Task 2.
  if (body?.env !== "dev" && body?.env !== "prod") {
    return err(400, "bad_env", 'env must be "dev" or "prod"');
  }

  try {
    const result = await mintInvoke(
      { userId: session.userId, orgId: session.orgId },
      agent.id,
      body.env
    );
    return ok({
      token: result.token,
      tokenId: result.tokenId,
      expiresAt: result.expiresAt.toISOString(),
    });
  } catch (e) {
    if (e instanceof EntitlementError) {
      if (e.reason === "no_plan") {
        return err(402, "subscription_required", "No active subscription — visit sanadcode.com/pricing to upgrade");
      }
      if (e.reason === "no_seat") {
        return err(403, "no_seat", "No seat assigned — ask your admin to assign you a seat");
      }
    }
    if (e instanceof QuotaExceededError) {
      return err(
        402,
        "quota_exceeded",
        `Monthly ${e.dimension} allowance exhausted — upgrade at sanadcode.com/pricing or wait for the next billing period`
      );
    }
    console.error("agent invoke-token mint error", e);
    return err(500, "internal_error", "Failed to mint invoke token", true);
  }
}
