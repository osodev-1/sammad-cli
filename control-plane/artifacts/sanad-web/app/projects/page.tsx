import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { projectSessions, workspaceSessions } from "@/lib/db/schema";
import { computeMode } from "@/lib/compute/mode";
import ProjectsClient, { type ProjectRow } from "./ProjectsClient";

export const metadata = { title: "sanad — projects" };

/**
 * Sessions & Projects (PRD §9.11). A project is a machine + workspace; each
 * project holds one or more sessions (restorable work state). This page lists
 * the user's projects with their session counts and lets them open (resume)
 * one — which restores that project's tabs and layout in the workspace.
 */
export default async function ProjectsPage() {
  const { userId } = await auth();
  if (!userId) redirect("/");

  let projects: ProjectRow[] = [];
  if (computeMode() === "aws") {
    const rows = await db
      .select()
      .from(workspaceSessions)
      .where(eq(workspaceSessions.userId, userId))
      .orderBy(asc(workspaceSessions.createdAt));

    projects = await Promise.all(
      rows.map(async (p) => {
        const sessions = await db
          .select({
            id: projectSessions.id,
            lastActiveAt: projectSessions.lastActiveAt,
          })
          .from(projectSessions)
          .where(
            and(
              eq(projectSessions.projectId, p.id),
              eq(projectSessions.userId, userId),
              isNull(projectSessions.archivedAt),
            ),
          );
        const lastActive = sessions
          .map((s) => s.lastActiveAt?.getTime() ?? 0)
          .reduce((a, b) => Math.max(a, b), p.updatedAt?.getTime() ?? 0);
        return {
          id: p.id,
          name: p.name,
          state: p.state,
          sessionCount: sessions.length,
          lastActiveAt: new Date(lastActive).toISOString(),
        };
      }),
    );
  }

  return (
    <ProjectsClient projects={projects} awsMode={computeMode() === "aws"} />
  );
}
