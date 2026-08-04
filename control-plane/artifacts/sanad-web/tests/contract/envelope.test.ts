import { describe, it, expect } from "vitest";
import { ok, err } from "@/lib/http/envelope";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("ok()", () => {
  it("wraps payload under { data, meta } with a UUID requestId", async () => {
    const res = ok({ foo: "bar" });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toMatchObject({
      data: { foo: "bar" },
      meta: { requestId: expect.stringMatching(UUID_RE) },
    });
    // error key must be absent
    expect(body.error).toBeUndefined();
  });

  it("accepts a custom HTTP status code", async () => {
    const res = ok({}, 201);
    expect(res.status).toBe(201);
  });

  it("emits a fresh requestId on each call (no shared state)", async () => {
    const a = await ok({}).json();
    const b = await ok({}).json();
    expect(a.meta.requestId).not.toBe(b.meta.requestId);
  });
});

describe("err()", () => {
  it("wraps error under { error } with code, message, requestId, retryable", async () => {
    const res = err(400, "bad_request", "Something went wrong");
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body).toMatchObject({
      error: {
        code: "bad_request",
        message: "Something went wrong",
        requestId: expect.stringMatching(UUID_RE),
        retryable: false,
      },
    });
    // data key must be absent
    expect(body.data).toBeUndefined();
  });

  it("propagates retryable=true", async () => {
    const res = err(500, "internal_error", "Oops", true);
    const body = await res.json();
    expect(body.error.retryable).toBe(true);
  });

  it("emits a fresh requestId on each call (no shared state)", async () => {
    const a = await err(500, "e", "m").json();
    const b = await err(500, "e", "m").json();
    expect(a.error.requestId).not.toBe(b.error.requestId);
  });
});
