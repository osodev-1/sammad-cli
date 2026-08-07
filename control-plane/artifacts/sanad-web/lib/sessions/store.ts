/**
 * Persistence for PRD Sessions (restorable work state per project).
 *
 * Ownership is always enforced by userId here — a caller can never read or
 * write another user's session state. Every project auto-gets one "default"
 * session on first touch, so the workspace always has somewhere to persist to;
 * multiple named sessions per project are supported by the schema and exposed
 * incrementally.
 */
import { and, asc, eq } from "drizzle-orm";
import { db } from "../db";
import { projectSessions } from "../db/schema";
import {
  EMPTY_SESSION_STATE,
  parseSessionState,
  type SessionUiState,
} from "./state";

export type ProjectSessionRow = typeof projectSessions.$inferSelect;

export interface PublicSession {
  id: string;
  projectId: string;
  name: string;
  uiState: SessionUiState;
  lastActiveAt: Date;
  createdAt: Date;
}

function toPublic(row: ProjectSessionRow): PublicSession {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    uiState: parseSessionState(row.uiState),
    lastActiveAt: row.lastActiveAt,
    createdAt: row.createdAt,
  };
}

/** All non-archived sessions for a project, oldest first. */
export async function listSessions(
  userId: string,
  projectId: string,
): Promise<PublicSession[]> {
  const rows = await db
    .select()
    .from(projectSessions)
    .where(
      and(
        eq(projectSessions.userId, userId),
        eq(projectSessions.projectId, projectId),
      ),
    )
    .orderBy(asc(projectSessions.createdAt));
  return rows.filter((r) => r.archivedAt === null).map(toPublic);
}

/** The project's default session, created on first touch. */
export async function getOrCreateDefaultSession(
  userId: string,
  projectId: string,
): Promise<PublicSession> {
  const existing = await listSessions(userId, projectId);
  if (existing.length > 0) return existing[0];
  return createSession(userId, projectId, "Workspace");
}

export async function createSession(
  userId: string,
  projectId: string,
  name: string,
): Promise<PublicSession> {
  const [row] = await db
    .insert(projectSessions)
    .values({
      id: crypto.randomUUID(),
      projectId,
      userId,
      name: name.trim().slice(0, 60) || "Workspace",
      uiState: EMPTY_SESSION_STATE,
    })
    .returning();
  return toPublic(row);
}

async function ownedSession(
  userId: string,
  sessionId: string,
): Promise<ProjectSessionRow | null> {
  const [row] = await db
    .select()
    .from(projectSessions)
    .where(
      and(
        eq(projectSessions.userId, userId),
        eq(projectSessions.id, sessionId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function renameSession(
  userId: string,
  sessionId: string,
  name: string,
): Promise<PublicSession | null> {
  const [row] = await db
    .update(projectSessions)
    .set({
      name: name.trim().slice(0, 60) || "Workspace",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(projectSessions.userId, userId),
        eq(projectSessions.id, sessionId),
      ),
    )
    .returning();
  return row ? toPublic(row) : null;
}

/** Persist restorable UI state (already validated by the caller). */
export async function saveSessionState(
  userId: string,
  sessionId: string,
  uiState: SessionUiState,
): Promise<boolean> {
  const owned = await ownedSession(userId, sessionId);
  if (!owned) return false;
  await db
    .update(projectSessions)
    .set({ uiState, updatedAt: new Date(), lastActiveAt: new Date() })
    .where(eq(projectSessions.id, sessionId));
  return true;
}

export async function archiveSession(
  userId: string,
  sessionId: string,
): Promise<boolean> {
  const [row] = await db
    .update(projectSessions)
    .set({ archivedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(projectSessions.userId, userId),
        eq(projectSessions.id, sessionId),
      ),
    )
    .returning();
  return row !== undefined;
}
