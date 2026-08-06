import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth/terminal-tickets", () => ({
  redeemTerminalTicket: vi.fn(),
}));

import { redeemTerminalTicket } from "@/lib/auth/terminal-tickets";
import { POST } from "@/app/api/v1/terminal/redeem/route";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-/i;
const SECRET = "test-terminal-secret";
const originalSecret = process.env.TERMINAL_SHARED_SECRET;

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

beforeEach(() => {
  vi.clearAllMocks();
  process.env.TERMINAL_SHARED_SECRET = SECRET;
});

afterAll(() => {
  if (originalSecret === undefined) delete process.env.TERMINAL_SHARED_SECRET;
  else process.env.TERMINAL_SHARED_SECRET = originalSecret;
});

describe("POST /api/v1/terminal/redeem", () => {
  it("503 when the shared secret is not configured", async () => {
    delete process.env.TERMINAL_SHARED_SECRET;
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
    vi.mocked(redeemTerminalTicket).mockResolvedValue({
      ok: true,
      sessionToken: "sess_abc",
      userId: "user_1",
      orgId: "personal_user_1",
      email: "a@b.test",
      displayName: "A B",
    });

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
