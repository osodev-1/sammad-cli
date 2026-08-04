import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth/device", () => ({
  startDevice: vi.fn(),
  pollDevice: vi.fn(),
}));

import { startDevice, pollDevice } from "@/lib/auth/device";
import { POST as startPOST } from "@/app/api/v1/auth/device/start/route";
import { POST as pollPOST } from "@/app/api/v1/auth/device/poll/route";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-/i;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

const DEVICE_START_RESPONSE = {
  deviceAuthId: "dauth_abc123",
  userCode: "ABCD-1234",
  verificationUri: "https://sanadcode.com/activate",
  verificationUriComplete: "https://sanadcode.com/activate?code=ABCD-1234",
  expiresAt: "2026-08-03T00:10:00.000Z",
  pollIntervalSeconds: 5,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/v1/auth/device/start", () => {
  it("returns 201 with all required fields", async () => {
    vi.mocked(startDevice).mockResolvedValue(DEVICE_START_RESPONSE);

    const req = new NextRequest(
      "http://localhost/api/v1/auth/device/start",
      { method: "POST" },
    );
    const res = await startPOST(req);

    expect(res.status).toBe(201);
    const body = await res.json();

    expect(body.data).toMatchObject({
      deviceAuthId: expect.any(String),
      userCode: expect.any(String),
      verificationUri: expect.any(String),
      verificationUriComplete: expect.any(String),
      expiresAt: expect.stringMatching(ISO_RE),
      pollIntervalSeconds: expect.any(Number),
    });
    expect(body.meta.requestId).toMatch(UUID_RE);
    // error key must be absent
    expect(body.error).toBeUndefined();
  });

  it("returns 500 when startDevice throws", async () => {
    vi.mocked(startDevice).mockRejectedValue(new Error("db failure"));

    const req = new NextRequest(
      "http://localhost/api/v1/auth/device/start",
      { method: "POST" },
    );
    const res = await startPOST(req);

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe("internal_error");
    expect(body.error.retryable).toBe(true);
  });
});

describe("POST /api/v1/auth/device/poll", () => {
  const makeReq = (body: unknown) =>
    new NextRequest("http://localhost/api/v1/auth/device/poll", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });

  it("returns status:'pending' while the device is awaiting authorization", async () => {
    vi.mocked(pollDevice).mockResolvedValue({ status: "pending" });

    const res = await pollPOST(makeReq({ deviceAuthId: "dauth_abc123" }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ status: "pending" });
    expect(body.meta.requestId).toMatch(UUID_RE);
  });

  it("returns 400 with device_code_expired when the code has expired", async () => {
    vi.mocked(pollDevice).mockResolvedValue({ kind: "expired" });

    const res = await pollPOST(makeReq({ deviceAuthId: "dauth_abc123" }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("device_code_expired");
  });

  it("returns 400 invalid_request when deviceAuthId is missing", async () => {
    const res = await pollPOST(makeReq({}));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_request");
  });

  it("returns 400 invalid_request when body is not JSON", async () => {
    const req = new NextRequest("http://localhost/api/v1/auth/device/poll", {
      method: "POST",
      body: "not-json",
      headers: { "Content-Type": "text/plain" },
    });
    const res = await pollPOST(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_request");
  });
});
