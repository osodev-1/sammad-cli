import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  memberships,
  organizations,
  subscriptions,
  users,
} from "@/lib/db/schema";
import TeamClient from "./TeamClient";

export default async function TeamPage() {
  const { userId } = await auth();
  if (!userId) redirect("/");

  const orgId = `personal_${userId}`;

  const [org] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  const [sub] = await db
    .select()
    .from(subscriptions)
    .where(
      and(eq(subscriptions.orgId, orgId), eq(subscriptions.status, "active"))
    )
    .limit(1);

  const [me] = await db
    .select()
    .from(memberships)
    .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, userId)))
    .limit(1);

  const rows = await db
    .select({
      membershipId: memberships.id,
      userId: memberships.userId,
      role: memberships.role,
      seatAssigned: memberships.seatAssigned,
      email: users.email,
      displayName: users.displayName,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(eq(memberships.orgId, orgId))
    .orderBy(memberships.createdAt);

  const isTeamPlan = sub?.plan === "team";
  const isAdmin = me?.role === "owner" || me?.role === "admin";

  return (
    <TeamClient
      orgName={org?.name ?? "My workspace"}
      plan={sub?.plan ?? "free"}
      isTeamPlan={isTeamPlan}
      isAdmin={isAdmin}
      seatLimit={sub?.seats ?? 1}
      currentUserId={userId}
      members={rows.map((r) => ({
        membershipId: r.membershipId,
        userId: r.userId,
        role: r.role,
        seatAssigned: r.seatAssigned,
        email: r.email,
        displayName: r.displayName,
      }))}
    />
  );
}
