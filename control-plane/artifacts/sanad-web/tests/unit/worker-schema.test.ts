import { describe, it, expect } from "vitest";
import { getTableColumns } from "drizzle-orm";
import {
  workspaces, agents, agentVersions, deployments, runs, invokeTokens,
} from "@/lib/db/schema";

describe("worker runtime schema", () => {
  it("agents require an owner and a workspace", () => {
    const cols = getTableColumns(agents);
    expect(cols.ownerUserId.notNull).toBe(true);
    expect(cols.workspaceId.notNull).toBe(true);
  });
  it("runs carry attribution and idempotency", () => {
    const cols = getTableColumns(runs);
    for (const k of ["deploymentId", "agentVersionId", "status", "triggerPrincipal"] as const)
      expect(cols[k].notNull, k).toBe(true);
    expect(cols.idempotencyKey.notNull).toBe(false);
  });
  it("invoke tokens are scoped to agent+env", () => {
    const cols = getTableColumns(invokeTokens);
    expect(cols.agentId.notNull).toBe(true);
    expect(cols.env.notNull).toBe(true);
    expect(cols.tokenHash.isUnique).toBe(true);
  });
});
