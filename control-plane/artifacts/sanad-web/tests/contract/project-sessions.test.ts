import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/* Auth gate: pass as an authorized workspace user. */
vi.mock("@/lib/workspace/proxy", () => ({
  authenticateWorkspace: vi.fn(async () => ({ ok: true, userId: "user_1" })),
}));
/* The project (machine) exists and belongs to user_1. */
vi.mock("@/lib/compute/sessions", () => ({
  getSession: vi.fn(async (userId: string, id: string) =>
    userId === "user_1" && id === "proj_1" ? { id, userId } : null,
  ),
}));

/* In-memory store stand-in for the drizzle-backed functions. */
const sessions: Array<{
  id: string;
  projectId: string;
  userId: string;
  name: string;
  uiState: unknown;
}> = [];
vi.mock("@/lib/sessions/store", () => ({
  listSessions: vi.fn(async (userId: string, projectId: string) =>
    sessions.filter((x) => x.userId === userId && x.projectId === projectId),
  ),
  getOrCreateDefaultSession: vi.fn(
    async (userId: string, projectId: string) => {
      let s = sessions.find(
        (x) => x.userId === userId && x.projectId === projectId,
      );
      if (!s) {
        s = {
          id: `ps_${sessions.length + 1}`,
          projectId,
          userId,
          name: "Workspace",
          uiState: {},
        };
        sessions.push(s);
      }
      return s;
    },
  ),
  createSession: vi.fn(
    async (userId: string, projectId: string, name: string) => {
      const s = {
        id: `ps_${sessions.length + 1}`,
        projectId,
        userId,
        name,
        uiState: {},
      };
      sessions.push(s);
      return s;
    },
  ),
  renameSession: vi.fn(async (userId: string, id: string, name: string) => {
    const s = sessions.find((x) => x.userId === userId && x.id === id);
    if (!s) return null;
    s.name = name;
    return s;
  }),
  saveSessionState: vi.fn(
    async (userId: string, id: string, uiState: unknown) => {
      const s = sessions.find((x) => x.userId === userId && x.id === id);
      if (!s) return false;
      s.uiState = uiState;
      return true;
    },
  ),
  archiveSession: vi.fn(async () => true),
}));

import { GET, POST } from "@/app/api/projects/[projectId]/sessions/route";
import { PATCH } from "@/app/api/projects/[projectId]/sessions/[sessionId]/route";

const projParams = (projectId: string) => ({
  params: Promise.resolve({ projectId }),
});
const sessParams = (projectId: string, sessionId: string) => ({
  params: Promise.resolve({ projectId, sessionId }),
});
const req = (body?: unknown) =>
  new NextRequest("http://test/api/projects/proj_1/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

beforeEach(() => {
  sessions.length = 0;
});

describe("GET project sessions", () => {
  it("404 for a project the user doesn't own", async () => {
    const res = await GET(req(), projParams("proj_other"));
    expect(res.status).toBe(404);
  });

  it("auto-creates and returns a default session", async () => {
    const res = await GET(req(), projParams("proj_1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.sessions).toHaveLength(1);
    expect(body.data.sessions[0].name).toBe("Workspace");
  });
});

describe("POST create session", () => {
  it("400 without a name", async () => {
    expect((await POST(req({}), projParams("proj_1"))).status).toBe(400);
  });
  it("creates a named session", async () => {
    const res = await POST(req({ name: "Feature work" }), projParams("proj_1"));
    expect(res.status).toBe(200);
    expect((await res.json()).data.session.name).toBe("Feature work");
  });
});

describe("PATCH session", () => {
  it("persists valid UI state", async () => {
    await GET(req(), projParams("proj_1")); // seed default
    const id = sessions[0].id;
    const good = {
      v: 1,
      terminals: [{ id: "term-1", label: "Agent" }],
      fileTabs: [{ path: "a.ts" }],
      viewTabs: [],
      active: "a.ts",
      drawerOpen: false,
    };
    const res = await PATCH(req({ uiState: good }), sessParams("proj_1", id));
    expect(res.status).toBe(200);
    expect(sessions[0].uiState).toEqual(good);
  });

  it("400 on malformed UI state (never persisted)", async () => {
    await GET(req(), projParams("proj_1"));
    const id = sessions[0].id;
    const res = await PATCH(
      req({ uiState: { v: 1, active: 42 } }),
      sessParams("proj_1", id),
    );
    expect(res.status).toBe(400);
  });

  it("renames a session", async () => {
    await GET(req(), projParams("proj_1"));
    const id = sessions[0].id;
    const res = await PATCH(req({ name: "Renamed" }), sessParams("proj_1", id));
    expect(res.status).toBe(200);
    expect(sessions[0].name).toBe("Renamed");
  });
});
