import { NextRequest } from "next/server";
import { z } from "zod";
import { ok, err } from "@/lib/http/envelope";
import { verifyBearer } from "@/lib/auth/session";
import { renewRuntime, EntitlementError } from "@/lib/tokens/runtime";
import { QuotaExceededError } from "@/lib/billing/quota";

const Body = z.object({ tokenId: z.string().min(1) });

export async function POST(req: NextRequest) {
  const session = await verifyBearer(req);
  if (!session) {
    return err(401, "unauthorized", "Invalid or revoked session token");
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return err(400, "invalid_request", "Request body must be JSON");
  }

  const parsed = Body.safeParse(body);
  if (!parsed.success) {
    return err(400, "invalid_request", "Missing tokenId");
  }

  try {
    const result = await renewRuntime(session, parsed.data.tokenId);
    return ok(result);
  } catch (e: unknown) {
    if (e instanceof EntitlementError) {
      if (e.reason === "no_plan") {
        return err(402, "subscription_required", "No active subscription — visit sanadcode.com/pricing to upgrade");
      }
      return err(403, "no_seat", "No seat assigned — ask your admin to assign you a seat");
    }
    if (e instanceof QuotaExceededError) {
      // Not retryable: waiting won't help, only upgrading or a period reset.
      return err(
        402,
        "quota_exceeded",
        `Monthly ${e.dimension} allowance exhausted — upgrade at sanadcode.com/pricing or wait for the next billing period`
      );
    }
    const msg = e instanceof Error ? e.message : "unknown";
    if (msg === "token_not_found" || msg === "token_expired") {
      return err(410, "token_expired", "Runtime token has expired or does not exist");
    }
    console.error("runtime-tokens renew error", e);
    return err(500, "internal_error", "Failed to renew runtime token", true);
  }
}
