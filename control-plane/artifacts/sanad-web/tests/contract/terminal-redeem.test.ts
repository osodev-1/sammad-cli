import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth/terminal-tickets", () => ({
  redeemTerminalTicket: vi.fn(),
}));

/* Table-aware db mock: machine identification must consult the SESSIONS table
   (new machines) and fall back to the legacy per-user table (old machines). */
let sessionRows: unknown[] = [];
let legacyRows: unknown[] = [];
vi.mock("@/lib/db", async () => {
  const { workspaceSessions } = await import("@/lib/db/schema");
  return {
    db: {
      select: () => ({
        from: (table: unknown) => ({
          where: () => ({
            limit: async () => (table === workspaceSessions ? sessionRows : legacyRows),
          }),
        }),
      }),
    },
  };
});

import { redeemTerminalTicket } from "@/lib/auth/terminal-tickets";
import { deriveMachineToken } from "@/lib/compute/tokens";
import { POST } from "@/app/api/v1/terminal/redeem/route";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-/i;
const SECRET = "test-terminal-secret";
const MACHINE_KEY = "test-machine-key";
const originalSecret = process.env.TERMINAL_SHARED_SECRET;
const originalMachineKey = process.env.TERMINAL_MACHINE_KEY;

function post(body: unknown, secret?: string): NextRequest {
  return new NextRequest("http://localhost/api/v1/terminal/redeem", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(secret !== undefined ? { "x-terminal-secret": secret } : {}),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function machinePost(body: unknown, token: string, nonce: string): NextRequest {
  return new NextRequest("http://localhost/api/v1/terminal/redeem", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-machine-token": token,
      "x-machine-nonce": nonce,
    },
    body: JSON.stringify(body),
  });
}

const GOOD_TICKET = {
  ok: true as const,
  sessionToken: "sess_abc",
  userId: "user_1",
  orgId: "personal_user_1",
  email: "a@b.test",
  displayName: "A B",
};

beforeEach(() => {
  vi.clearAllMocks();
  sessionRows = [];
  legacyRows = [];
  process.env.TERMINAL_SHARED_SECRET = SECRET;
  process.env.TERMINAL_MACHINE_KEY = MACHINE_KEY;
});

afterAll(() => {
  if (originalSecret === undefined) delete process.env.TERMINAL_SHARED_SECRET;
  else process.env.TERMINAL_SHARED_SECRET = originalSecret;
  if (originalMachineKey === undefined) delete process.env.TERMINAL_MACHINE_KEY;
  else process.env.TERMINAL_MACHINE_KEY = originalMachineKey;
});

describe("POST /api/v1/terminal/redeem", () => {
  it("503 when neither credential scheme is configured", async () => {
    delete process.env.TERMINAL_SHARED_SECRET;
    delete process.env.TERMINAL_MACHINE_KEY;
    const res = await POST(post({ ticket: "tt_x" }, SECRET));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.code).toBe("terminal_unavailable");
  });

  it("401 on missing or wrong secret header", async () => {
    expect((await POST(post({ ticket: "tt_x" }))).status).toBe(401);
    expect((await POST(post({ ticket: "tt_x" }, "wrong"))).status).toBe(401);
    expect(vi.mocked(redeemTerminalTicket)).not.toHaveBeenCalled();
  });

  it("400 on malformed body", async () => {
    expect((await POST(post("not json", SECRET))).status).toBe(400);
    expect((await POST(post({}, SECRET))).status).toBe(400);
  });

  it.each([
    ["not_found", 404, "not_found"],
    ["expired", 410, "ticket_expired"],
    ["already_redeemed", 409, "conflict"],
  ] as const)("maps %s to HTTP %d", async (reason, status, code) => {
    vi.mocked(redeemTerminalTicket).mockResolvedValue({ ok: false, reason });
    const res = await POST(post({ ticket: "tt_x" }, SECRET));
    expect(res.status).toBe(status);
    const body = await res.json();
    expect(body.error.code).toBe(code);
  });

  it("200 returns the exact key set the terminal service parses", async () => {
    vi.mocked(redeemTerminalTicket).mockResolvedValue(GOOD_TICKET);

    const res = await POST(post({ ticket: "tt_x" }, SECRET));
    expect(res.status).toBe(200);
    const body = await res.json();

    // The Python terminal service parses these keys — pin them exactly.
    expect(Object.keys(body.data).sort()).toEqual([
      "displayName",
      "email",
      "orgId",
      "sessionToken",
      "userId",
    ]);
    expect(body.data.sessionToken).toBe("sess_abc");
    expect(body.meta.requestId).toMatch(UUID_RE);
    expect(vi.mocked(redeemTerminalTicket)).toHaveBeenCalledWith("tt_x");
  });
});

describe("machine-credential redeem (session machines)", () => {
  const NONCE = "nonce-1234";

  it("200 for a machine whose nonce lives in the SESSIONS table", async () => {
    // The regression: post-migration machines exist only here — a redeem
    // that consults just the legacy table 401s every one of them.
    sessionRows = [{ userId: "user_1" }];
    vi.mocked(redeemTerminalTicket).mockResolvedValue(GOOD_TICKET);
    const token = deriveMachineToken("user_1", NONCE);
    const res = await POST(machinePost({ ticket: "tt_x" }, token, NONCE));
    expect(res.status).toBe(200);
  });

  it("200 for a legacy machine whose nonce lives only in workspace_tasks", async () => {
    legacyRows = [{ userId: "user_1" }];
    vi.mocked(redeemTerminalTicket).mockResolvedValue(GOOD_TICKET);
    const token = deriveMachineToken("user_1", NONCE);
    const res = await POST(machinePost({ ticket: "tt_x" }, token, NONCE));
    expect(res.status).toBe(200);
  });

  it("401 for an unknown nonce", async () => {
    const token = deriveMachineToken("user_1", NONCE);
    const res = await POST(machinePost({ ticket: "tt_x" }, token, NONCE));
    expect(res.status).toBe(401);
    expect(vi.mocked(redeemTerminalTicket)).not.toHaveBeenCalled();
  });

  it("401 for a known nonce with a forged token", async () => {
    sessionRows = [{ userId: "user_1" }];
    const res = await POST(machinePost({ ticket: "tt_x" }, "forged-token", NONCE));
    expect(res.status).toBe(401);
    expect(vi.mocked(redeemTerminalTicket)).not.toHaveBeenCalled();
  });

  it("403 when a machine redeems another user's ticket (burned either way)", async () => {
    sessionRows = [{ userId: "user_2" }];
    vi.mocked(redeemTerminalTicket).mockResolvedValue(GOOD_TICKET); // ticket owner: user_1
    const token = deriveMachineToken("user_2", NONCE);
    const res = await POST(machinePost({ ticket: "tt_x" }, token, NONCE));
    expect(res.status).toBe(403);
  });
});
