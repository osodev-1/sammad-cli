import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn(),
  currentUser: vi.fn(),
}));
vi.mock("@/lib/clerk/provisioning", () => ({
  provisionPersonalOrg: vi.fn(async () => ({ orgId: "personal_user_1" })),
}));
vi.mock("@/lib/auth/entitlement", () => ({
  requireEntitled: vi.fn(),
}));
vi.mock("@/lib/auth/terminal-tickets", () => ({
  mintTerminalTicket: vi.fn(),
}));

let membershipRows: unknown[] = [];
vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => membershipRows }),
      }),
    }),
  },
}));

import { auth, currentUser } from "@clerk/nextjs/server";
import { requireEntitled } from "@/lib/auth/entitlement";
import { mintTerminalTicket } from "@/lib/auth/terminal-tickets";
import { provisionPersonalOrg } from "@/lib/clerk/provisioning";
import { POST } from "@/app/api/terminal/session/route";

const ENV_KEYS = ["SANAD_TERMINAL_EMAILS", "TERMINAL_WS_URL"] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

function signIn(orgId: string | null = null, email = "omar@x.test") {
  vi.mocked(auth).mockResolvedValue({ userId: "user_1", orgId } as never);
  vi.mocked(currentUser).mockResolvedValue({
    emailAddresses: [{ emailAddress: email }],
    firstName: "Omar",
    lastName: null,
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  membershipRows = [];
  process.env.SANAD_TERMINAL_EMAILS = "omar@x.test";
  process.env.TERMINAL_WS_URL = "wss://terminal.test/ws";
  vi.mocked(requireEntitled).mockResolvedValue({ ok: true });
  vi.mocked(mintTerminalTicket).mockResolvedValue({ ticket: "tt_abc", expiresIn: 60 });
});

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const sessionRequest = () =>
  new Request("http://test/api/terminal/session", { method: "POST" });

describe("POST /api/terminal/session", () => {
  it("401 when signed out", async () => {
    vi.mocked(auth).mockResolvedValue({ userId: null, orgId: null } as never);
    const res = await POST(sessionRequest());
    expect(res.status).toBe(401);
  });

  it("403 terminal_not_enabled when not on the allowlist", async () => {
    signIn(null, "stranger@x.test");
    const res = await POST(sessionRequest());
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("terminal_not_enabled");
    expect(vi.mocked(mintTerminalTicket)).not.toHaveBeenCalled();
  });

  it("403 no_plan when entitlement fails", async () => {
    signIn();
    vi.mocked(requireEntitled).mockResolvedValue({ ok: false, reason: "no_plan" });
    const res = await POST(sessionRequest());
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("no_plan");
  });

  it("503 when TERMINAL_WS_URL is not configured", async () => {
    signIn();
    delete process.env.TERMINAL_WS_URL;
    const res = await POST(sessionRequest());
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.code).toBe("terminal_unavailable");
  });

  it("200 mints a ticket for the personal org", async () => {
    signIn();
    const res = await POST(sessionRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({
      ticket: "tt_abc",
      wsUrl: "wss://terminal.test/ws",
      expiresIn: 60,
      coldStart: false,
    });
    expect(vi.mocked(provisionPersonalOrg)).toHaveBeenCalled();
    expect(vi.mocked(mintTerminalTicket)).toHaveBeenCalledWith("user_1", "personal_user_1");
  });

  it("falls back to the personal org when the Clerk-active org has no membership", async () => {
    signIn("org_team_1");
    membershipRows = []; // no membership row for org_team_1
    const res = await POST(sessionRequest());
    expect(res.status).toBe(200);
    expect(vi.mocked(requireEntitled)).toHaveBeenCalledWith("personal_user_1", "user_1");
    expect(vi.mocked(mintTerminalTicket)).toHaveBeenCalledWith("user_1", "personal_user_1");
  });

  it("uses the Clerk-active org when a membership exists", async () => {
    signIn("org_team_1");
    membershipRows = [{ id: "mem_1" }];
    const res = await POST(sessionRequest());
    expect(res.status).toBe(200);
    expect(vi.mocked(mintTerminalTicket)).toHaveBeenCalledWith("user_1", "org_team_1");
  });
});
