import { randomBytes } from "crypto";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import {
  deviceAuthRequests,
  cliSessions,
  users,
  organizations,
  memberships,
} from "../db/schema";
import { newToken, hashToken } from "./tokens";

const APP_URL = process.env.APP_URL ?? "http://localhost:3000";

/** 8-character user code (uppercase, no ambiguous chars) */
function generateUserCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(8);
  return Array.from({ length: 8 }, (_, i) => chars[bytes[i] % chars.length]).join("");
}

export async function startDevice() {
  const deviceAuthId = newToken("dev");
  const userCode = generateUserCode();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 min

  await db.insert(deviceAuthRequests).values({
    id: crypto.randomUUID(),
    deviceAuthIdHash: hashToken(deviceAuthId),
    userCode,
    status: "pending",
    pollIntervalSeconds: 2,
    expiresAt,
  });

  return {
    deviceAuthId,
    userCode,
    verificationUri: `${APP_URL}/device`,
    verificationUriComplete: `${APP_URL}/device?code=${userCode}`,
    expiresAt: expiresAt.toISOString(),
    pollIntervalSeconds: 2,
  };
}

export type PollResult =
  | { status: "pending" }
  | {
      status: "complete";
      cliSessionToken: string;
      user: { id: string; email: string; displayName?: string };
      organization: { id: string; name: string; slug: string };
      membership: { id: string; role: string };
    }
  | { kind: "denied" }
  | { kind: "expired" }
  | { kind: "not_found" };

export async function pollDevice(deviceAuthId: string): Promise<PollResult> {
  const hash = hashToken(deviceAuthId);
  const [row] = await db
    .select()
    .from(deviceAuthRequests)
    .where(eq(deviceAuthRequests.deviceAuthIdHash, hash))
    .limit(1);

  if (!row) return { kind: "not_found" };

  const now = new Date();

  // Expire pending rows past their TTL
  if (row.status === "pending" && row.expiresAt < now) {
    await db
      .update(deviceAuthRequests)
      .set({ status: "expired" })
      .where(eq(deviceAuthRequests.id, row.id));
    return { kind: "expired" };
  }

  if (row.status === "expired") return { kind: "expired" };
  if (row.status === "denied") return { kind: "denied" };

  if (row.status === "complete" && row.pendingSessionToken) {
    // Consume the pending token (clear it so it is single-use)
    const plainToken = row.pendingSessionToken;
    await db
      .update(deviceAuthRequests)
      .set({ pendingSessionToken: null })
      .where(eq(deviceAuthRequests.id, row.id));

    // Fetch user, org, membership for the response
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, row.approvedUserId!))
      .limit(1);
    const [org] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, row.approvedOrgId!))
      .limit(1);
    const [membership] = await db
      .select()
      .from(memberships)
      .where(
        and(
          eq(memberships.userId, row.approvedUserId!),
          eq(memberships.orgId, row.approvedOrgId!)
        )
      )
      .limit(1);

    return {
      status: "complete",
      cliSessionToken: plainToken,
      user: {
        id: user.id,
        email: user.email,
        ...(user.displayName ? { displayName: user.displayName } : {}),
      },
      organization: { id: org.id, name: org.name, slug: org.slug },
      membership: { id: membership.id, role: membership.role },
    };
  }

  // complete but token already consumed — re-poll returns pending until user re-approves
  if (row.status === "complete" && !row.pendingSessionToken) {
    // Token already consumed; return status pending (CLI will have already got it)
    return { status: "pending" };
  }

  return { status: "pending" };
}
