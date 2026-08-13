import { describe, it, expect, vi, beforeEach } from "vitest";

const state: { agentRow: any } = { agentRow: { id: "ag_1", status: "active" } };
// Queue of results for successive select().from().where().limit() calls, so
// tests that need more than one distinct select (e.g. upsertAgent's
// ensureWorkspace lookup followed by its own agent lookup) can script each
// call in order. Falls back to [state.agentRow] when empty, which preserves
// the original single-select tests unchanged.
let selectQueue: any[][] = [];
const updateCalls: any[] = [];
const insertCalls: any[] = [];

vi.mock("@/lib/db", () => ({
  db: {
    insert: vi.fn(() => ({
      values: vi.fn(async (v: any) => {
        insertCalls.push(v);
      }),
      onConflictDoNothing: vi.fn(),
    })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => (selectQueue.length ? selectQueue.shift()! : [state.agentRow])),
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn((v: any) => {
        updateCalls.push(v);
        return { where: vi.fn(async () => {}) };
      }),
    })),
  },
}));

import {
  bundleContentHash,
  createDeployment,
  OwnerRequiredError,
  upsertAgent,
} from "@/lib/agents/registry";

beforeEach(() => {
  selectQueue = [];
  updateCalls.length = 0;
  insertCalls.length = 0;
  state.agentRow = { id: "ag_1", status: "active" };
});

describe("agent registry", () => {
  it("bundle hash is key-order independent", () => {
    expect(bundleContentHash({ b: "2", a: "1" })).toBe(bundleContentHash({ a: "1", b: "2" }));
  });

  it("deploying an orphaned agent throws owner_required", async () => {
    state.agentRow = { id: "ag_1", status: "orphaned" };
    await expect(
      createDeployment({ agentId: "ag_1", versionId: "av_1", env: "dev" })
    ).rejects.toBeInstanceOf(OwnerRequiredError);
  });

  it("creating a deployment supersedes prior active/paused rows, then inserts the new one as active", async () => {
    state.agentRow = { id: "ag_1", status: "active" };
    const { id } = await createDeployment({ agentId: "ag_1", versionId: "av_2", env: "prod" });

    expect(id).toMatch(/^dp_/);
    expect(updateCalls).toEqual([{ status: "superseded", updatedAt: expect.any(Date) }]);
    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0]).toMatchObject({ env: "prod", status: "active" });
  });

  it("upserting an existing agent never changes ownerUserId, only refreshes description", async () => {
    // ensureWorkspace's select finds an existing workspace...
    selectQueue.push([{ id: "ws_1" }]);
    // ...then upsertAgent's own select finds an existing agent in it.
    selectQueue.push([{ id: "ag_1" }]);

    const result = await upsertAgent({
      orgId: "org_1",
      workspaceName: "default",
      name: "my-agent",
      ownerUserId: "user_someone_else",
      description: "refreshed description",
    });

    expect(result).toEqual({ id: "ag_1" });
    expect(updateCalls).toEqual([{ description: "refreshed description" }]);
    expect(updateCalls[0]).not.toHaveProperty("ownerUserId");
    expect(updateCalls[0]).not.toHaveProperty("status");
  });

  it("upserting an existing agent with no description issues no update at all", async () => {
    selectQueue.push([{ id: "ws_1" }]);
    selectQueue.push([{ id: "ag_1" }]);

    const result = await upsertAgent({
      orgId: "org_1",
      workspaceName: "default",
      name: "my-agent",
      ownerUserId: "user_someone_else",
    });

    expect(result).toEqual({ id: "ag_1" });
    expect(updateCalls).toHaveLength(0);
    expect(insertCalls).toHaveLength(0);
  });
});
