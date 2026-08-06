import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn(),
  currentUser: vi.fn(),
}));

import { auth, currentUser } from "@clerk/nextjs/server";
import { GET as treeGET } from "@/app/api/workspace/tree/route";
import { PUT as filePUT } from "@/app/api/workspace/file/route";

const ENV_KEYS = [
  "SANAD_TERMINAL_EMAILS",
  "TERMINAL_INTERNAL_URL",
  "TERMINAL_SHARED_SECRET",
] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

function signIn(email = "omar@x.test") {
  vi.mocked(auth).mockResolvedValue({ userId: "user_1" } as never);
  vi.mocked(currentUser).mockResolvedValue({
    emailAddresses: [{ emailAddress: email }],
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SANAD_TERMINAL_EMAILS = "omar@x.test";
  process.env.TERMINAL_INTERNAL_URL = "https://terminal.internal";
  process.env.TERMINAL_SHARED_SECRET = "svc-secret";
});

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.unstubAllGlobals();
});

describe("workspace proxy routes", () => {
  it("401 when signed out; 403 when not allowlisted; upstream never called", async () => {
    vi.mocked(auth).mockResolvedValue({ userId: null } as never);
    let res = await treeGET(new NextRequest("http://localhost/api/workspace/tree"));
    expect(res.status).toBe(401);

    signIn("stranger@x.test");
    res = await treeGET(new NextRequest("http://localhost/api/workspace/tree"));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("terminal_not_enabled");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("injects service headers and re-wraps internal JSON in the envelope", async () => {
    signIn();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ entries: [{ name: "a", path: "a", kind: "file" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );

    const res = await treeGET(
      new NextRequest("http://localhost/api/workspace/tree?path=docs")
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.entries).toHaveLength(1);
    expect(body.meta.requestId).toBeTruthy();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://terminal.internal/internal/workspace/tree?path=docs");
    const headers = new Headers(init.headers);
    expect(headers.get("x-terminal-secret")).toBe("svc-secret");
    expect(headers.get("x-workspace-user")).toBe("user_1");
  });

  it("maps internal errors onto the envelope with the internal code", async () => {
    signIn();
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ error: { code: "invalid_path", message: "path escapes" } }),
        { status: 400, headers: { "content-type": "application/json" } }
      )
    );
    const res = await treeGET(
      new NextRequest("http://localhost/api/workspace/tree?path=../evil")
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_path");
  });

  it("PUT /file requires a path", async () => {
    signIn();
    const res = await filePUT(
      new NextRequest("http://localhost/api/workspace/file", { method: "PUT", body: "x" })
    );
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
