/**
 * Browser-side client for PRD Session persistence. Thin wrappers over the
 * /api/projects/:projectId/sessions/* routes; all failures are swallowed to a
 * null/void — persistence is convenience, never allowed to break the workspace.
 */
import type { SessionUiState } from "./state";

export interface LoadedSession {
  id: string;
  name: string;
  uiState: SessionUiState;
}

/** The project's default session (auto-created server-side) and its state. */
export async function loadDefaultSession(
  projectId: string,
): Promise<LoadedSession | null> {
  try {
    const res = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/sessions`,
    );
    if (!res.ok) return null;
    const body = await res.json();
    const first = body?.data?.sessions?.[0];
    if (!first) return null;
    return { id: first.id, name: first.name, uiState: first.uiState };
  } catch {
    return null;
  }
}

export async function persistSessionState(
  projectId: string,
  sessionId: string,
  uiState: SessionUiState,
): Promise<void> {
  try {
    await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ uiState }),
      },
    );
  } catch {
    /* the next change re-attempts; a lost save is never fatal */
  }
}
