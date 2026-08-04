import { NextRequest } from "next/server";
import { ok, err } from "@/lib/http/envelope";
import { verifyBearer } from "@/lib/auth/session";
import { mintRuntime, EntitlementError } from "@/lib/tokens/runtime";
import { QuotaExceededError } from "@/lib/billing/quota";

export async function POST(req: NextRequest) {
  const session = await verifyBearer(req);
  if (!session) {
    return err(401, "unauthorized", "Invalid or revoked session token");
  }

  try {
    const result = await mintRuntime(session);
    return ok(result);
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
      // Not retryable: waiting won't help, only upgrading or a period reset.
      return err(
        402,
        "quota_exceeded",
        `Monthly ${e.dimension} allowance exhausted — upgrade at sanadcode.com/pricing or wait for the next billing period`
      );
    }
    console.error("runtime-tokens mint error", e);
    return err(500, "internal_error", "Failed to mint runtime token", true);
  }
}
