import { db } from "../db";
import {
  users,
  organizations,
  memberships,
  subscriptions,
} from "../db/schema";
import { eq, and } from "drizzle-orm";
import { freePlanState } from "../billing/plans";

interface UserInput {
  id: string;
  email: string;
  displayName?: string;
}

/**
 * Idempotently provision a personal org (of one) for a newly-created user.
 * - Upserts the users row
 * - Creates a personal org keyed by personal_<userId>
 * - Creates a membership (owner, seat assigned)
 * - Creates a free subscription for the org
 */
export async function provisionPersonalOrg(
  user: UserInput
): Promise<{ orgId: string }> {
  const orgId = `personal_${user.id}`;

  // Upsert user
  await db
    .insert(users)
    .values({
      id: user.id,
      email: user.email,
      displayName: user.displayName ?? null,
    })
    .onConflictDoUpdate({
      target: users.id,
      set: { email: user.email, displayName: user.displayName ?? null },
    });

  // Upsert personal org
  await db
    .insert(organizations)
    .values({
      id: orgId,
      name: `${user.displayName ?? user.email}'s workspace`,
      slug: `personal-${user.id}`,
      type: "personal",
    })
    .onConflictDoNothing();

  // Upsert membership
  const membershipId = `mem_${user.id}_${orgId}`;
  await db
    .insert(memberships)
    .values({
      id: membershipId,
      orgId,
      userId: user.id,
      role: "owner",
      seatAssigned: true,
    })
    .onConflictDoNothing();

  // Upsert free subscription. Shares freePlanState() with the Stripe downgrade
  // path so a cancelled org lands back on exactly this state.
  await db
    .insert(subscriptions)
    .values({
      id: `sub_${orgId}`,
      orgId,
      ...freePlanState(),
    })
    .onConflictDoNothing();

  return { orgId };
}
