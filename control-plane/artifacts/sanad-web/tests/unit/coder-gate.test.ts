import { describe, it, expect, afterEach, vi } from "vitest";

const auth = vi.fn();
const currentUser = vi.fn();
vi.mock("@clerk/nextjs/server", () => ({
  auth: (...a: unknown[]) => auth(...a),
  currentUser: (...a: unknown[]) => currentUser(...a),
}));

import { authenticateCoderPanel } from "@/lib/workspace/proxy";

describe("authenticateCoderPanel", () => {
  const origTerm = process.env.SANAD_TERMINAL_EMAILS;
  const origCoder = process.env.SANAD_CODER_PANEL_EMAILS;
  afterEach(() => {
    process.env.SANAD_TERMINAL_EMAILS = origTerm ?? "";
    process.env.SANAD_CODER_PANEL_EMAILS = origCoder ?? "";
    if (origTerm === undefined) delete process.env.SANAD_TERMINAL_EMAILS;
    if (origCoder === undefined) delete process.env.SANAD_CODER_PANEL_EMAILS;
    vi.clearAllMocks();
  });

  it("401 when not signed in", async () => {
    auth.mockResolvedValue({ userId: null });
    const gate = await authenticateCoderPanel();
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.response.status).toBe(401);
  });

  it("403 terminal_not_enabled when workspace access is missing", async () => {
    auth.mockResolvedValue({ userId: "u1" });
    currentUser.mockResolvedValue({ emailAddresses: [{ emailAddress: "x@y.z" }] });
    process.env.SANAD_TERMINAL_EMAILS = "";
    process.env.SANAD_CODER_PANEL_EMAILS = "x@y.z";
    const gate = await authenticateCoderPanel();
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.response.status).toBe(403);
  });

  it("403 coder_not_enabled when only the coder allowlist is missing", async () => {
    auth.mockResolvedValue({ userId: "u1" });
    currentUser.mockResolvedValue({ emailAddresses: [{ emailAddress: "x@y.z" }] });
    process.env.SANAD_TERMINAL_EMAILS = "x@y.z";
    process.env.SANAD_CODER_PANEL_EMAILS = "";
    const gate = await authenticateCoderPanel();
    expect(gate.ok).toBe(false);
    if (!gate.ok) {
      expect(gate.response.status).toBe(403);
      const body = await gate.response.json();
      expect(body.error.code).toBe("coder_not_enabled");
    }
  });

  it("ok with both allowlists", async () => {
    auth.mockResolvedValue({ userId: "u1" });
    currentUser.mockResolvedValue({ emailAddresses: [{ emailAddress: "x@y.z" }] });
    process.env.SANAD_TERMINAL_EMAILS = "x@y.z";
    process.env.SANAD_CODER_PANEL_EMAILS = "x@y.z";
    const gate = await authenticateCoderPanel();
    expect(gate.ok).toBe(true);
    if (gate.ok) expect(gate.userId).toBe("u1");
  });
});
