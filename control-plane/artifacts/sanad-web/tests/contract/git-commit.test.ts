import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/workspace/proxy", () => ({
  authenticateWorkspace: vi.fn(async () => ({ ok: true, userId: "user_1" })),
  workspaceFetch: vi.fn(),
  relayJson: vi.fn(async (r: Response) => r),
}));
vi.mock("@clerk/nextjs/server", () => ({
  currentUser: vi.fn(async () => ({
    firstName: "Omar",
    lastName: "A",
    username: "omar",
    emailAddresses: [{ emailAddress: "omar@sanadcode.com" }],
  })),
}));

import { workspaceFetch } from "@/lib/workspace/proxy";
import { POST } from "@/app/api/git/commit/route";

const req = (body: unknown) =>
  new NextRequest("http://test/api/git/commit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.mocked(workspaceFetch).mockReset();
  vi.mocked(workspaceFetch).mockResolvedValue(
    new Response(JSON.stringify({ ok: true, head: "abc123" }), { status: 200 }),
  );
});

describe("POST /api/git/commit", () => {
  it("400 without a message", async () => {
    const res = await POST(req({}));
    expect(res.status).toBe(400);
    expect(vi.mocked(workspaceFetch)).not.toHaveBeenCalled();
  });

  it("injects the Clerk identity server-side, ignoring any client-sent author", async () => {
    await POST(
      req({
        message: "feat: x",
        authorName: "Attacker",
        authorEmail: "evil@x",
      }),
    );
    const [, path, init] = vi.mocked(workspaceFetch).mock.calls[0];
    expect(path).toBe("/internal/git/commit");
    const sent = JSON.parse((init as { body: string }).body);
    expect(sent).toEqual({
      message: "feat: x",
      authorName: "Omar A",
      authorEmail: "omar@sanadcode.com",
    });
  });
});
