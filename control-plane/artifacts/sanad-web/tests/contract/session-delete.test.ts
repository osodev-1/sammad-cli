import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/workspace/proxy", () => ({ authenticateWorkspace: vi.fn() }));
vi.mock("@/lib/compute/mode", () => ({ computeMode: vi.fn() }));
vi.mock("@/lib/compute/sessions", () => ({
  deleteSession: vi.fn(),
  renameSession: vi.fn(),
}));

import { authenticateWorkspace } from "@/lib/workspace/proxy";
import { computeMode } from "@/lib/compute/mode";
import { deleteSession } from "@/lib/compute/sessions";
import { DELETE } from "@/app/api/sessions/[id]/route";

const req = () =>
  new NextRequest("http://localhost/api/sessions/proj_1", { method: "DELETE" });
const params = { params: Promise.resolve({ id: "proj_1" }) };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(authenticateWorkspace).mockResolvedValue({
    ok: true,
    userId: "user_a",
  } as never);
  vi.mocked(computeMode).mockReturnValue("aws" as never);
  vi.mocked(deleteSession).mockResolvedValue(true);
});

describe("DELETE /api/sessions/[id] — project deletion", () => {
  it("cascades through deleteSession scoped to the caller", async () => {
    const res = await DELETE(req(), params);
    expect(res.status).toBe(200);
    // Ownership rides the authenticated user — never a body-supplied id.
    expect(vi.mocked(deleteSession)).toHaveBeenCalledWith("user_a", "proj_1");
  });

  it("404s when the project is not the caller's", async () => {
    vi.mocked(deleteSession).mockResolvedValue(false);
    const res = await DELETE(req(), params);
    expect(res.status).toBe(404);
  });

  it("503s outside the compute platform without touching the cascade", async () => {
    vi.mocked(computeMode).mockReturnValue("railway" as never);
    const res = await DELETE(req(), params);
    expect(res.status).toBe(503);
    expect(vi.mocked(deleteSession)).not.toHaveBeenCalled();
  });

  it("surfaces a cascade failure as a retryable 503, not a silent success", async () => {
    vi.mocked(deleteSession).mockRejectedValue(new Error("aws down"));
    const res = await DELETE(req(), params);
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("session_delete_failed");
  });
});
