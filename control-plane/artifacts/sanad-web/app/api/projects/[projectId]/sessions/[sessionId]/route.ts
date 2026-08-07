import { NextRequest } from "next/server";
import { ok, err } from "@/lib/http/envelope";
import { authenticateWorkspace } from "@/lib/workspace/proxy";
import {
  archiveSession,
  renameSession,
  saveSessionState,
} from "@/lib/sessions/store";
import { sessionUiState } from "@/lib/sessions/state";

/** Rename and/or persist the restorable UI state of one session. */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string; sessionId: string }> },
) {
  const gate = await authenticateWorkspace();
  if (!gate.ok) return gate.response;
  const { sessionId } = await params;
  const body = (await req.json().catch(() => null)) as {
    name?: string;
    uiState?: unknown;
  } | null;
  if (!body) return err(400, "invalid_request", "Body must be JSON");

  let updated = false;

  if (typeof body.name === "string" && body.name.trim()) {
    const row = await renameSession(gate.userId, sessionId, body.name);
    if (!row) return err(404, "not_found", "No such session");
    updated = true;
  }

  if (body.uiState !== undefined) {
    // Reject malformed state rather than persisting garbage the client can't
    // restore — the workspace degrades to an empty session on read anyway.
    const parsed = sessionUiState.safeParse(body.uiState);
    if (!parsed.success) {
      return err(400, "invalid_request", "Malformed session state");
    }
    const saved = await saveSessionState(gate.userId, sessionId, parsed.data);
    if (!saved) return err(404, "not_found", "No such session");
    updated = true;
  }

  if (!updated) return err(400, "invalid_request", "Nothing to update");
  return ok({ ok: true });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ projectId: string; sessionId: string }> },
) {
  const gate = await authenticateWorkspace();
  if (!gate.ok) return gate.response;
  const { sessionId } = await params;
  const done = await archiveSession(gate.userId, sessionId);
  if (!done) return err(404, "not_found", "No such session");
  return ok({ archived: true });
}
