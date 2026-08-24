import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { NextRequest } from "next/server";

/**
 * End-to-end coverage of the proxy→client 202 contract (P4 Task 4 review
 * finding, Critical #1): `sendCoder`'s `isQueuedSendResponse` guard is
 * correct in isolation, but a raw 202 upstream NEVER reaches the browser —
 * this route sits in between. Before the fix, `POST /send`'s
 * `!upstream.ok || !upstream.body` check let a 202 (a 2xx, so `ok===true`,
 * with a body) fall through to the raw-stream passthrough and get relayed
 * as `200 + application/x-ndjson` — silently defeating the client's guard.
 * These tests exercise the REAL `relayJson` (only Clerk auth and the
 * upstream `fetch` are mocked) so the actual route branching + envelope
 * transform is what's under test, not a mocked stand-in for it.
 */

vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn(),
  currentUser: vi.fn(),
}));

import { auth, currentUser } from "@clerk/nextjs/server";
import { POST } from "@/app/api/coder/conversations/[cid]/send/route";

const ENV_KEYS = [
  "SANAD_TERMINAL_EMAILS",
  "SANAD_CODER_PANEL_EMAILS",
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
  process.env.SANAD_CODER_PANEL_EMAILS = "omar@x.test";
  process.env.TERMINAL_INTERNAL_URL = "https://terminal.internal";
  process.env.TERMINAL_SHARED_SECRET = "svc-secret";
  signIn();
});

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.unstubAllGlobals();
});

const req = () =>
  new NextRequest("http://localhost/api/coder/conversations/c_1/send?session=sess1", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input: "hi", sendId: "sid_1" }),
  });

const call = () => POST(req(), { params: Promise.resolve({ cid: "c_1" }) });

describe("POST /api/coder/conversations/[cid]/send — the 202 proxy contract", () => {
  it("a 202 upstream (auto-queued busy send) is relayed as 200 + application/json, NEVER as an ndjson stream", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: true, queued: true, position: 2 }), {
        status: 202,
        headers: { "content-type": "application/json" },
      }),
    );
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("content-type")).not.toContain("ndjson");
    const body = await res.json();
    // relayJson's envelope — this is exactly the shape sendCoder's
    // isQueuedSendResponse + `b?.data ?? b` unwrap expects.
    expect(body.data).toEqual({ ok: true, queued: true, position: 2 });
  });

  it("a normal 200 ndjson stream still passes straight through, unchanged", async () => {
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode('{"kind":"end","status":"finished"}\n'));
        c.close();
      },
    });
    fetchMock.mockResolvedValue(
      new Response(stream, {
        status: 200,
        headers: { "content-type": "application/x-ndjson" },
      }),
    );
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");
    const text = await res.text();
    expect(text).toBe('{"kind":"end","status":"finished"}\n');
  });

  it("a busy 409 (the narrow TOCTOU race) still relays as a JSON error, not a stream", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ error: { code: "busy", message: "a turn is already in progress" } }),
        { status: 409, headers: { "content-type": "application/json" } },
      ),
    );
    const res = await call();
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("busy");
  });
});
