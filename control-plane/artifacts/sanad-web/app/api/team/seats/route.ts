import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { memberships } from "@/lib/db/schema";
import {
  requireOrgAdmin,
  requireTeamSubscription,
  countAssignedSeats,
} from "@/lib/auth/team";
import { revokeSessionsForMember } from "@/lib/auth/session";
import { getUncachableStripeClient } from "@/lib/stripe/client";
import {
  resolveSeats,
  type StripeSubscriptionShape,
} from "@/lib/stripe/subscription-state";

/**
 * Assign or revoke a seat on a membership.
 * Body: { membershipId: string, assigned: boolean }
 *
 * Before assigning, the seat count is validated against the live Stripe
 * subscription quantity (falling back to the mirrored `subscriptions.seats`
 * column if Stripe is unreachable or the subscription id is missing).
 */
export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as {
    membershipId?: string;
    assigned?: boolean;
  } | null;

  if (!body?.membershipId || typeof body.assigned !== "boolean") {
    return NextResponse.json(
      { error: "membershipId and assigned are required" },
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
      { error: "An active Team subscription is required to manage seats" },
      { status: 402 }
    );
  }

  const [membership] = await db
    .select()
    .from(memberships)
    .where(
      and(eq(memberships.id, body.membershipId), eq(memberships.orgId, orgId))
    )
    .limit(1);

  if (!membership) {
    return NextResponse.json(
      { error: "Membership not found in this org" },
      { status: 404 }
    );
  }

  if (body.assigned && !membership.seatAssigned) {
    // Validate against the Stripe subscription quantity, not just our mirror.
    let seatLimit = sub.seats;
    if (sub.stripeSubscriptionId) {
      try {
        const stripe = await getUncachableStripeClient();
        const stripeSub = (await stripe.subscriptions.retrieve(
          sub.stripeSubscriptionId
        )) as unknown as StripeSubscriptionShape;
        seatLimit = resolveSeats(stripeSub);
      } catch (err) {
        console.error(
          "Seat assignment: failed to read Stripe quantity, using mirrored seats",
          err
        );
      }
    }

    const used = await countAssignedSeats(orgId);
    if (used >= seatLimit) {
      return NextResponse.json(
        {
          error: `All ${seatLimit} seats are in use. Increase the subscription quantity to add more.`,
        },
        { status: 409 }
      );
    }
  }

  await db
    .update(memberships)
    .set({ seatAssigned: body.assigned })
    .where(eq(memberships.id, membership.id));

  // Losing a seat means losing entitlement: cut off any live CLI sessions
  // (and their runtime tokens) immediately instead of waiting for expiry.
  if (!body.assigned) {
    await revokeSessionsForMember(orgId, membership.userId);
  }

  return NextResponse.json({
    ok: true,
    membershipId: membership.id,
    seatAssigned: body.assigned,
  });
}
