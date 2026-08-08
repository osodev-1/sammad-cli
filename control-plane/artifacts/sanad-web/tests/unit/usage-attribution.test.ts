import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Project attribution flows through the token chain: a web-terminal CLI session
 * is stamped with its workspace project at mint time, and the gateway's usage
 * ingest resolves that project back through the runtime-token → cli-session
 * join. These tests pin the two ends of that chain (the middle — the ingest
 * writing `projectId: runtime.projectId` — is a straight field pass verified by
 * the type checker).
 */

const insertValues = vi.fn().mockResolvedValue(undefined);
const selectLimit = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    insert: vi.fn(() => ({ values: insertValues })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        innerJoin: vi.fn(() => ({
          where: vi.fn(() => ({ limit: selectLimit })),
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
    })),
  },
}));

import { mintSession } from "@/lib/auth/session";
import { verifyRuntimeBearer } from "@/lib/tokens/runtime";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("usage attribution: project id through the token chain", () => {
  it("mintSession stamps the project id on the cli_sessions row", async () => {
    await mintSession("u1", "o1", undefined, "Web terminal", "project:hh");
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "u1",
        orgId: "o1",
        projectId: "project:hh",
      }),
    );
  });

  it("mintSession leaves project id null for non-workspace sessions", async () => {
    await mintSession("u1", "o1", "device_req_1"); // device-flow login
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: null }),
    );
  });

  it("verifyRuntimeBearer surfaces the owning session's project id", async () => {
    const future = new Date(Date.now() + 60_000);
    selectLimit.mockResolvedValue([
      {
        tokenId: "t1",
        cliSessionId: "s1",
        userId: "u1",
        orgId: "o1",
        projectId: "project:hh",
        expiresAt: future,
        absoluteExpiresAt: future,
        sessionRevokedAt: null,
      },
    ]);
    const info = await verifyRuntimeBearer(
      new Request("https://sanadcode.com/v1/usage", {
        method: "POST",
        headers: { authorization: "Bearer rtok_live" },
      }),
    );
    expect(info).toMatchObject({ orgId: "o1", projectId: "project:hh" });
  });

  it("verifyRuntimeBearer returns null project id when the session had none", async () => {
    const future = new Date(Date.now() + 60_000);
    selectLimit.mockResolvedValue([
      {
        tokenId: "t2",
        cliSessionId: "s2",
        userId: "u1",
        orgId: "o1",
        projectId: null,
        expiresAt: future,
        absoluteExpiresAt: future,
        sessionRevokedAt: null,
      },
    ]);
    const info = await verifyRuntimeBearer(
      new Request("https://sanadcode.com/v1/usage", {
        method: "POST",
        headers: { authorization: "Bearer rtok_local" },
      }),
    );
    expect(info?.projectId).toBeNull();
  });
});
