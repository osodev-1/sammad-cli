import { NextRequest } from "next/server";
import { auth, currentUser } from "@clerk/nextjs/server";
import { z } from "zod";
import { ok, err } from "@/lib/http/envelope";
import { db } from "@/lib/db";
import { deviceAuthRequests, users } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { hashToken } from "@/lib/auth/tokens";
import { mintSession } from "@/lib/auth/session";
import { requireEntitled } from "@/lib/auth/entitlement";
import { provisionPersonalOrg } from "@/lib/clerk/provisioning";

const Body = z.object({
  userCode: z.string().min(1),
  action: z.enum(["approve", "deny"]),
});

export async function POST(req: NextRequest) {
  const { userId, orgId } = await auth();
  if (!userId) {
    return err(401, "unauthorized", "Must be signed in to approve a device request");
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return err(400, "invalid_request", "Request body must be JSON");
  }

  const parsed = Body.safeParse(body);
  if (!parsed.success) {
    return err(400, "invalid_request", "Missing userCode or action");
  }

  const { userCode, action } = parsed.data;

  // Find the device request by userCode
  const [row] = await db
    .select()
    .from(deviceAuthRequests)
    .where(eq(deviceAuthRequests.userCode, userCode))
    .limit(1);

  if (!row) {
    return err(404, "not_found", "Device code not found");
  }

  if (row.status !== "pending") {
    return err(409, "conflict", `Device request is already ${row.status}`);
  }

  if (row.expiresAt < new Date()) {
    await db
      .update(deviceAuthRequests)
      .set({ status: "expired" })
      .where(eq(deviceAuthRequests.id, row.id));
    return err(410, "device_code_expired", "Device code has expired");
  }

  if (action === "deny") {
    await db
      .update(deviceAuthRequests)
      .set({ status: "denied" })
      .where(eq(deviceAuthRequests.id, row.id));
    return ok({ denied: true });
  }

  // Determine active org — use personal org if no org is active in the Clerk session
  const clerkUser = await currentUser();
  const activeOrgId = orgId ?? `personal_${userId}`;

  // Ensure the user is provisioned (idempotent)
  await provisionPersonalOrg({
    id: userId,
    email: clerkUser?.emailAddresses[0]?.emailAddress ?? "",
    displayName:
      clerkUser?.firstName && clerkUser?.lastName
        ? `${clerkUser.firstName} ${clerkUser.lastName}`
        : clerkUser?.firstName ?? undefined,
  });

  // Entitlement check
  const ent = await requireEntitled(activeOrgId, userId);
  if (!ent.ok) {
    const reason = ent.reason === "no_plan" ? "no_plan" : "no_seat";
    const message =
      ent.reason === "no_plan"
        ? "No active subscription — visit /pricing to upgrade"
        : "No seat assigned — ask your admin to assign a seat";
    return err(403, reason, message);
  }

  // Mint the CLI session token
  const plainToken = await mintSession(userId, activeOrgId, row.id);

  // Mark the device request as complete, stash the plaintext token for poll
  await db
    .update(deviceAuthRequests)
    .set({
      status: "complete",
      approvedUserId: userId,
      approvedOrgId: activeOrgId,
      pendingSessionToken: plainToken,
    })
    .where(eq(deviceAuthRequests.id, row.id));

  return ok({ approved: true });
}
