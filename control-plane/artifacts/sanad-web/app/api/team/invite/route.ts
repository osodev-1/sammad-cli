import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { eq, and } from "drizzle-orm";
import { db } from "@/lib/db";
import { memberships, users } from "@/lib/db/schema";
import { requireOrgAdmin, requireTeamSubscription } from "@/lib/auth/team";

/**
 * Invite a member to the org by email.
 * Body: { email: string }
 *
 * The invited person must already have a Sanad account (users are provisioned
 * by the Clerk webhook on sign-up). New members join without a seat; the admin
 * assigns one explicitly from the team page.
 */
export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as {
    email?: string;
  } | null;
  const email = body?.email?.trim().toLowerCase();
  if (!email || !email.includes("@")) {
    return NextResponse.json(
      { error: "A valid email is required" },
      { status: 400 }
    );
  }

  const orgId = `personal_${userId}`;

  const adminCheck = await requireOrgAdmin(orgId, userId);
  if (!adminCheck.ok) {
    return NextResponse.json(
      { error: adminCheck.error },
      { status: adminCheck.status }
    );
  }

  const sub = await requireTeamSubscription(orgId);
  if (!sub) {
    return NextResponse.json(
      { error: "An active Team subscription is required to invite members" },
      { status: 402 }
    );
  }

  const [invitee] = await db
    .select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (!invitee) {
    return NextResponse.json(
      {
        error:
          "No account exists for that email yet. Ask them to sign up first, then invite them again.",
      },
      { status: 404 }
    );
  }

  const [existing] = await db
    .select()
    .from(memberships)
    .where(
      and(eq(memberships.orgId, orgId), eq(memberships.userId, invitee.id))
    )
    .limit(1);

  if (existing) {
    return NextResponse.json(
      { error: "That person is already a member of this team" },
      { status: 409 }
    );
  }

  const membershipId = `mem_${invitee.id}_${orgId}`;
  await db.insert(memberships).values({
    id: membershipId,
    orgId,
    userId: invitee.id,
    role: "member",
    seatAssigned: false,
  });

  return NextResponse.json({
    ok: true,
    membershipId,
    email: invitee.email,
  });
}
