import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { NextRequest } from "next/server";

let taskRows: unknown[] = [];
vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => taskRows }),
      }),
    }),
  },
}));

import { GET } from "@/app/api/v1/compute/route/route";

const saved = process.env.ROUTER_SHARED_SECRET;
const SECRET = "router-secret";
const HASH = "abc123def456";

function get(hash: string, secret?: string): NextRequest {
  return new NextRequest(`http://localhost/api/v1/compute/route?hash=${hash}`, {
    headers: secret !== undefined ? { "x-router-secret": secret } : {},
  });
}

beforeEach(() => {
  taskRows = [];
  process.env.ROUTER_SHARED_SECRET = SECRET;
});
afterAll(() => {
  if (saved === undefined) delete process.env.ROUTER_SHARED_SECRET;
  else process.env.ROUTER_SHARED_SECRET = saved;
});

describe("GET /api/v1/compute/route", () => {
  it("503 unconfigured; 401 wrong secret; 400 bad hash", async () => {
    delete process.env.ROUTER_SHARED_SECRET;
    expect((await GET(get(HASH, SECRET))).status).toBe(503);

    process.env.ROUTER_SHARED_SECRET = SECRET;
    expect((await GET(get(HASH))).status).toBe(401);
    expect((await GET(get(HASH, "wrong"))).status).toBe(401);
    expect((await GET(get("NOT-A-HASH", SECRET))).status).toBe(400);
  });

  it("404 when the workspace has no running task", async () => {
    taskRows = [];
    expect((await GET(get(HASH, SECRET))).status).toBe(404);
    taskRows = [{ hash12: HASH, taskIp: null }];
    expect((await GET(get(HASH, SECRET))).status).toBe(404);
  });

  it("200 with the task IP", async () => {
    taskRows = [{ hash12: HASH, taskIp: "10.0.3.7" }];
    const res = await GET(get(HASH, SECRET));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ taskIp: "10.0.3.7" });
  });
});
