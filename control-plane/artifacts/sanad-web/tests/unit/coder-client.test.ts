import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ensureConversation,
  takeoverConversation,
  sendCoder,
  fetchCoderTurn,
  fetchCoderDiff,
  hasFreshDiff,
  revertCoder,
  respondCoder,
  setCoderMode,
  steerCoder,
  queueCoder,
  dequeueCoder,
  textFromEvent,
  thinkFromEvent,
  toolLabel,
  modeFromEvent,
  needsInterruptedReplay,
  isQueuedSendResponse,
  composerButtonsForPhase,
  describeStartError,
  isTakeoverNotification,
  takeoverNotificationMessage,
  TAKEN_OVER_ERROR_CODE,
} from "@/lib/coder/client";
import type { CoderItem, CoderTurnSummary } from "@/lib/coder/types";

function streamOf(...chunks: string[]): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "application/x-ndjson" },
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("sendCoder stream parsing", () => {
  it("reassembles NDJSON across chunk boundaries and surfaces request/request_resolved in order", async () => {
    // The TextPart line is deliberately cut mid-JSON between the two chunks.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        streamOf(
          '{"kind":"turn","turnId":"t_1"}\n{"kind":"event","event":{"type":"TextPart","payload":{"text":"Hel',
          'lo"}}}\n{"kind":"request","requestType":"approval","requestId":"r_1","turnId":"t_1","request":{"id":"r_1","action":"Shell"}}\n{"kind":"request_resolved","requestId":"r_1","requestType":"approval","resolution":{"response":"approve"}}\n{"kind":"end","status":"finished"}\n',
        ),
      ),
    );
    const items: CoderItem[] = [];
    await sendCoder("c_1", "hi", undefined, "sess1", (i: CoderItem) =>
      items.push(i),
    );

    expect(items).toHaveLength(5);
    expect(items[0]).toEqual({ kind: "turn", turnId: "t_1" });
    expect(textFromEvent(items[1])).toBe("Hello");
    expect(items[2]).toEqual({
      kind: "request",
      requestType: "approval",
      requestId: "r_1",
      turnId: "t_1",
      request: { id: "r_1", action: "Shell" },
    });
    expect(items[3]).toEqual({
      kind: "request_resolved",
      requestId: "r_1",
      requestType: "approval",
      resolution: { response: "approve" },
    });
    expect(items[4]).toEqual({ kind: "end", status: "finished" });
  });

  it("maps a busy 409 to a single error item carrying the turnId", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(409, { error: { code: "busy", turnId: "t_1" } }),
      ),
    );
    const items: CoderItem[] = [];
    await sendCoder("c_1", "hi", undefined, "sess1", (i: CoderItem) =>
      items.push(i),
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "error",
      code: "busy",
      turnId: "t_1",
    });
  });

  it("returns {kind:'streamed'} after a normal 200 ndjson stream", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(streamOf('{"kind":"end","status":"finished"}\n')),
    );
    const result = await sendCoder("c_1", "hi", undefined, "sess1", () => {});
    expect(result).toEqual({ kind: "streamed" });
  });

  // LOAD-BEARING (Task 2 review finding): a busy `/send` now auto-queues
  // server-side and answers 202 with a JSON envelope `{"ok":true,"queued":
  // true,"position":n}` — NOT an NDJSON stream. Because of the client/
  // server phase-view race, the IDLE send path can still hit a running
  // turn and get this 202. A 202 must NEVER be fed to `streamNdjson`: this
  // proves `onItem` is never called and the JSON envelope is surfaced as a
  // typed "queued" result instead.
  it("a 202 queued response is NEVER streamed — onItem is never called, and the envelope surfaces as a queued result", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(202, { ok: true, queued: true, position: 3 }),
      ),
    );
    const items: CoderItem[] = [];
    const result = await sendCoder("c_1", "hi", "sid_1", "sess1", (i: CoderItem) =>
      items.push(i),
    );
    expect(items).toHaveLength(0);
    expect(result).toEqual({ kind: "queued", position: 3 });
  });

  it("a 202 queued response with a double-enveloped body {data:{...}} still maps to a queued result", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(202, { data: { ok: true, queued: true, position: 1 } }),
      ),
    );
    const items: CoderItem[] = [];
    const result = await sendCoder("c_1", "hi", "sid_1", "sess1", (i: CoderItem) =>
      items.push(i),
    );
    expect(items).toHaveLength(0);
    expect(result).toEqual({ kind: "queued", position: 1 });
  });

  // Task 4 review finding (Critical #1): the Next.js proxy (`app/api/coder/
  // conversations/[cid]/send/route.ts`) does NOT preserve the upstream 202 —
  // it re-wraps a queued response through `relayJson`, which answers
  // `200 + application/json` with the envelope double-wrapped under `data`
  // (see `coder-send-route.test.ts` for the route-level half of this proof).
  // This is the REALISTIC shape `sendCoder` actually receives in production;
  // without `isQueuedSendResponse`'s non-ndjson-content-type fallback this
  // would silently fall through to `streamNdjson` (status 200 looks like a
  // normal stream at a glance) — proving the fallback branch, not just the
  // `status===202` fast path, is load-bearing.
  it("the POST-FIX proxy shape (200 + application/json, {data:{...}} envelope) is still caught as queued, never streamed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(200, { data: { ok: true, queued: true, position: 4 } }),
      ),
    );
    const items: CoderItem[] = [];
    const result = await sendCoder("c_1", "hi", "sid_1", "sess1", (i: CoderItem) =>
      items.push(i),
    );
    expect(items).toHaveLength(0);
    expect(result).toEqual({ kind: "queued", position: 4 });
  });
});

describe("isQueuedSendResponse (the 202-safety guard, pure)", () => {
  it("a 202 status is always queued, regardless of content-type", () => {
    expect(isQueuedSendResponse(202, "application/json")).toBe(true);
    expect(isQueuedSendResponse(202, null)).toBe(true);
  });

  it("a normal 200 ndjson stream is NOT queued", () => {
    expect(isQueuedSendResponse(200, "application/x-ndjson")).toBe(false);
  });

  it("a 200/2xx response with a non-ndjson content-type is treated as queued (defense in depth)", () => {
    expect(isQueuedSendResponse(200, "application/json")).toBe(true);
    expect(isQueuedSendResponse(200, null)).toBe(true);
  });

  it("a non-2xx status (error responses) is never treated as queued", () => {
    expect(isQueuedSendResponse(409, "application/json")).toBe(false);
    expect(isQueuedSendResponse(500, null)).toBe(false);
  });
});

describe("composerButtonsForPhase (the composer's steer-vs-send-vs-queue routing, pure)", () => {
  it("idle (ready) routes to Send, no Queue button", () => {
    expect(composerButtonsForPhase("ready")).toEqual({
      primaryLabel: "Send",
      primaryAction: "send",
      showQueue: false,
    });
  });

  it("a streaming turn routes the primary action to Steer now, with Queue offered alongside", () => {
    expect(composerButtonsForPhase("streaming")).toEqual({
      primaryLabel: "Steer now",
      primaryAction: "steer",
      showQueue: true,
    });
  });

  it("busy (a turn is running elsewhere) routes the same as streaming — the turn is still live", () => {
    expect(composerButtonsForPhase("busy")).toEqual({
      primaryLabel: "Steer now",
      primaryAction: "steer",
      showQueue: true,
    });
  });

  it("starting and error both fall back to the idle Send routing (the composer itself disables only on error)", () => {
    expect(composerButtonsForPhase("starting").primaryAction).toBe("send");
    expect(composerButtonsForPhase("error").primaryAction).toBe("send");
  });
});

describe("fetchCoderTurn", () => {
  it("unwraps the double envelope {data:{turn,alive,pendingRequests}}", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          data: {
            turn: {
              turnId: "t_1",
              status: "running",
              userInput: "hi",
              lastSeq: 3,
              startedAt: 100,
            },
            alive: true,
            pendingRequests: [
              {
                requestId: "r_1",
                requestType: "question",
                turnId: "t_1",
                createdAt: 5,
                request: {},
              },
            ],
          },
          meta: { requestId: "req_1" },
        }),
      ),
    );
    const state = await fetchCoderTurn("c_1", "sess1");
    expect(state?.turn?.turnId).toBe("t_1");
    expect(state?.alive).toBe(true);
    expect(state?.pendingRequests).toHaveLength(1);
    expect(state?.pendingRequests[0].requestId).toBe("r_1");
  });

  it("tolerates the bare (non-double-wrapped) shape, defaulting missing pendingRequests to []", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(200, { turn: null, alive: false })),
    );
    const state = await fetchCoderTurn("c_1", "sess1");
    expect(state).toEqual({ turn: null, alive: false, pendingRequests: [] });
  });

  it("surfaces mode from the response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          turn: null,
          alive: true,
          pendingRequests: [],
          mode: "accept-edits",
        }),
      ),
    );
    const state = await fetchCoderTurn("c_1", "sess1");
    expect(state?.mode).toBe("accept-edits");
  });

  it("surfaces the restart-recovery 'interrupted' status (P3 Task 2/3) faithfully, with an empty pendingRequests", async () => {
    // `CoderTurnSummary.status` must accept the literal "interrupted" — a
    // type-level check via this assignment, not just a runtime one:
    // pre-Task-4 this line would fail `tsc --noEmit`.
    const status: CoderTurnSummary["status"] = "interrupted";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          turn: {
            turnId: "t_1",
            status,
            userInput: "fix the bug",
            lastSeq: 4,
            startedAt: 100,
          },
          alive: true,
          pendingRequests: [],
        }),
      ),
    );
    const state = await fetchCoderTurn("c_1", "sess1");
    expect(state?.turn?.status).toBe("interrupted");
    expect(state?.pendingRequests).toEqual([]);
  });

  it("defaults mode to undefined when the response omits it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(200, { turn: null, alive: false, mode: null })),
    );
    const state = await fetchCoderTurn("c_1", "sess1");
    expect(state?.mode).toBeUndefined();
  });

  it("surfaces the server-side queue (P4b) from the response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          turn: { turnId: "t_1", status: "running", userInput: "hi", lastSeq: 0, startedAt: 1 },
          alive: true,
          pendingRequests: [],
          queue: [{ sendId: "q_1", input: "next thing" }],
        }),
      ),
    );
    const state = await fetchCoderTurn("c_1", "sess1");
    expect(state?.queue).toEqual([{ sendId: "q_1", input: "next thing" }]);
  });

  it("defaults queue to undefined when the response omits it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(200, { turn: null, alive: false })),
    );
    const state = await fetchCoderTurn("c_1", "sess1");
    expect(state?.queue).toBeUndefined();
  });
});

describe("ensureConversation", () => {
  it("happy-create: mints a ticket then creates, ticket flows into the create body", async () => {
    const fetchMock = vi.fn();
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(200, { data: { ticket: "tk_1", wsUrl: "wss://x" } }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, { data: { conversationId: "c_1" } }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await ensureConversation(undefined, "sess1");

    expect(result).toEqual({ ok: true, conversationId: "c_1" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [mintUrl] = fetchMock.mock.calls[0];
    expect(mintUrl).toBe("/api/terminal/session");
    const [createUrl, createInit] = fetchMock.mock.calls[1];
    expect(String(createUrl)).toContain("/api/coder/conversations");
    expect(JSON.parse(createInit.body)).toEqual({ ticket: "tk_1" });
  });

  it("open-falls-through-to-create: invalid_conversation on open mints a SECOND (one-time) ticket for create", async () => {
    const fetchMock = vi.fn();
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(200, { data: { ticket: "tk_1", wsUrl: "wss://x" } }),
      ) // mint #1
      .mockResolvedValueOnce(
        jsonResponse(400, {
          error: { code: "invalid_conversation", message: "malformed conversation id" },
        }),
      ) // open fails
      .mockResolvedValueOnce(
        jsonResponse(200, { data: { ticket: "tk_2", wsUrl: "wss://x" } }),
      ) // mint #2
      .mockResolvedValueOnce(
        jsonResponse(200, { data: { conversationId: "c_new" } }),
      ); // create succeeds
    vi.stubGlobal("fetch", fetchMock);

    const result = await ensureConversation("c_old", "sess1");

    expect(result).toEqual({ ok: true, conversationId: "c_new" });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const mintCalls = fetchMock.mock.calls.filter(
      (call: unknown[]) => call[0] === "/api/terminal/session",
    );
    expect(mintCalls).toHaveLength(2);
    const [, openInit] = fetchMock.mock.calls[1];
    expect(JSON.parse(openInit.body)).toEqual({ ticket: "tk_1" });
    const [, createInit] = fetchMock.mock.calls[3];
    expect(JSON.parse(createInit.body)).toEqual({ ticket: "tk_2" });
  });

  it("surfaces coder_not_enabled distinctly", async () => {
    const fetchMock = vi.fn();
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(200, { data: { ticket: "tk_1", wsUrl: "wss://x" } }),
      )
      .mockResolvedValueOnce(
        jsonResponse(403, {
          error: {
            code: "coder_not_enabled",
            message: "The coding agent is not enabled for this account",
          },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await ensureConversation(undefined, "sess1");

    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("coder_not_enabled");
    expect(result.error).toBe("The coding agent is not enabled for this account");
  });

  // P6b: the data-losing bug this guards against is `ensureConversation`
  // treating a `session_owned`/`session_busy` 409 as a "the conversation is
  // gone" signal and falling through to CREATE a brand new one — silently
  // abandoning the one the OTHER view is holding. Asserting the mock was
  // called exactly twice (mint + open, never a third `/conversations`
  // POST) is what actually fails against a naively-widened `fallsThrough`;
  // asserting only `result.ok === false` would pass even if a create call
  // happened right after (as long as ITS response also came back ok:false).
  it("a session_owned 409 on open does NOT fall through to create — surfaces uiMode/busy instead", async () => {
    const fetchMock = vi.fn();
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(200, { data: { ticket: "tk_1", wsUrl: "wss://x" } }),
      )
      .mockResolvedValueOnce(
        jsonResponse(409, {
          error: {
            code: "session_owned",
            message: "already open in the terminal",
            uiMode: "shell",
            busy: false,
          },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await ensureConversation("c_owned", "sess1");

    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("session_owned");
    expect(result.uiMode).toBe("shell");
    expect(result.busy).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2); // mint + open — NEVER a create call
    const urls = fetchMock.mock.calls.map((call: unknown[]) => String(call[0]));
    expect(urls.some((u) => u === "/api/coder/conversations")).toBe(false);
  });

  it("a session_busy 409 on open does NOT fall through to create — surfaces uiMode/busy instead", async () => {
    const fetchMock = vi.fn();
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(200, { data: { ticket: "tk_1", wsUrl: "wss://x" } }),
      )
      .mockResolvedValueOnce(
        jsonResponse(409, {
          error: {
            code: "session_busy",
            message: "mid-turn in the browser panel",
            uiMode: "wire",
            busy: true,
          },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await ensureConversation("c_busy", "sess1");

    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("session_busy");
    expect(result.uiMode).toBe("wire");
    expect(result.busy).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const urls = fetchMock.mock.calls.map((call: unknown[]) => String(call[0]));
    expect(urls.some((u) => u === "/api/coder/conversations")).toBe(false);
  });
});

describe("takeoverConversation", () => {
  it("re-POSTs /open with takeover:true using a FRESH ticket", async () => {
    const fetchMock = vi.fn();
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(200, { data: { ticket: "tk_2", wsUrl: "wss://x" } }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { data: {} }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await takeoverConversation("c_1", "sess1");

    expect(result).toEqual({ ok: true, conversationId: "c_1" });
    const [openUrl, openInit] = fetchMock.mock.calls[1];
    expect(String(openUrl)).toContain("/api/coder/conversations/c_1/open");
    expect(JSON.parse(openInit.body)).toEqual({ ticket: "tk_2", takeover: true });
  });

  it("a takeover against a BUSY owner surfaces session_busy distinctly (never waited on)", async () => {
    const fetchMock = vi.fn();
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(200, { data: { ticket: "tk_2", wsUrl: "wss://x" } }),
      )
      .mockResolvedValueOnce(
        jsonResponse(409, {
          error: {
            code: "session_busy",
            message: "mid-turn in the terminal",
            uiMode: "shell",
            busy: true,
          },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await takeoverConversation("c_1", "sess1");

    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("session_busy");
    expect(result.uiMode).toBe("shell");
  });

  it("a network failure surfaces as a generic error, not a crash", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("boom")),
    );
    const result = await takeoverConversation("c_1", "sess1");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("Network error — check your connection.");
  });
});

// P6b Task 4: the pure branch-selection matrix — the single place that
// decides what the panel's error state SAYS and whether it offers a Take
// over button. JSX is review-gated; this function is what's actually
// tested. Every case below would fail against an unfixed
// `startErrorCode === "coder_not_enabled" ? ... : startError` ternary (the
// pre-P6b code) since it has no concept of session_owned/session_busy/
// taken-over at all — it would just render the raw server `message`.
describe("describeStartError (the takeover/busy/taken-over branch matrix, pure)", () => {
  it("owned + idle -> takeover-offer, names the terminal from uiMode='shell'", () => {
    const view = describeStartError("session_owned", "shell", false, "irrelevant server text");
    expect(view.kind).toBe("takeover-offer");
    expect(view.otherView).toBe("the terminal");
    expect(view.message).toBe(
      "This conversation is open in the terminal. Take it over here?",
    );
  });

  it("owned + idle -> takeover-offer, names the browser panel from uiMode='wire'", () => {
    const view = describeStartError("session_owned", "wire", false, undefined);
    expect(view.kind).toBe("takeover-offer");
    expect(view.otherView).toBe("the browser panel");
  });

  // The discriminating case: a PLAIN (non-takeover) open always comes back
  // coded "session_owned" even when the owner is mid-turn — `busy` is the
  // real signal here, not the code. A helper that only switches on
  // `errorCode` (ignoring `busy`) would wrongly return "takeover-offer" and
  // FAIL this assertion.
  it("owned + busy (code still session_owned) -> busy-refusal, NO takeover offered", () => {
    const view = describeStartError("session_owned", "shell", true, "irrelevant");
    expect(view.kind).toBe("busy-refusal");
    expect(view.message).toBe(
      "That conversation is mid-turn in the terminal — cancel it there, or wait.",
    );
  });

  it("session_busy code -> busy-refusal even if the busy flag were somehow missing", () => {
    const view = describeStartError("session_busy", "wire", undefined, "irrelevant");
    expect(view.kind).toBe("busy-refusal");
    expect(view.otherView).toBe("the browser panel");
  });

  it("taken-over (client-synthetic code) renders its own message, no takeover/try-again copy leaks in", () => {
    const view = describeStartError(
      TAKEN_OVER_ERROR_CODE,
      undefined,
      undefined,
      "This conversation was taken over in the terminal.",
    );
    expect(view.kind).toBe("taken-over");
    expect(view.message).toBe("This conversation was taken over in the terminal.");
  });

  it("an ordinary error code falls through to generic, using the server message verbatim", () => {
    const view = describeStartError("network", undefined, undefined, "Network error — check your connection.");
    expect(view.kind).toBe("generic");
    expect(view.message).toBe("Network error — check your connection.");
  });

  it("coder_not_enabled keeps its own fixed copy regardless of server message", () => {
    const view = describeStartError("coder_not_enabled", undefined, undefined, "some server text");
    expect(view.kind).toBe("generic");
    expect(view.message).toBe("The coding agent isn't enabled for this account.");
  });
});

describe("isTakeoverNotification / takeoverNotificationMessage (P6b taken-over notice)", () => {
  it("recognizes the exact wire shape the CLI publishes on cooperative stand-down", () => {
    const item: CoderItem = {
      kind: "event",
      event: {
        type: "Notification",
        payload: {
          type: "session_lease_taken_over",
          body: "This conversation was taken over in the terminal.",
        },
      },
    };
    expect(isTakeoverNotification(item)).toBe(true);
    expect(takeoverNotificationMessage(item)).toBe(
      "This conversation was taken over in the terminal.",
    );
  });

  // Guards against a helper that matches on the OUTER event type alone
  // ("Notification") without checking the inner discriminator — the CLI's
  // generic notification channel could carry other notification kinds.
  it("does NOT match an unrelated Notification (wrong inner type)", () => {
    const item: CoderItem = {
      kind: "event",
      event: { type: "Notification", payload: { type: "some_other_notice", body: "x" } },
    };
    expect(isTakeoverNotification(item)).toBe(false);
  });

  it("does NOT match ordinary content/tool events", () => {
    const item: CoderItem = {
      kind: "event",
      event: { type: "TextPart", payload: { text: "hi" } },
    };
    expect(isTakeoverNotification(item)).toBe(false);
  });

  it("falls back to generic copy when the server body is missing/malformed", () => {
    const item: CoderItem = {
      kind: "event",
      event: { type: "Notification", payload: { type: "session_lease_taken_over" } },
    };
    expect(takeoverNotificationMessage(item)).toBe(
      "This conversation was taken over in another view.",
    );
  });
});

describe("respondCoder", () => {
  it("maps a 410 to {ok:false, code:'request_gone'}", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(410, {
          error: { code: "request_gone", message: "no such pending request" },
        }),
      ),
    );
    const result = await respondCoder(
      "c_1",
      "r_1",
      { response: "approve" },
      "sess1",
    );
    expect(result.ok).toBe(false);
    expect(result.code).toBe("request_gone");
  });
});

describe("setCoderMode", () => {
  it("POSTs {mode} to the mode endpoint and returns {ok:true} on 200", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true, mode: "accept-edits" }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await setCoderMode("c_1", "accept-edits", "sess1");

    expect(result).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("/api/coder/conversations/c_1/mode?session=sess1");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ mode: "accept-edits" });
  });

  it("maps a 409 not_started body to {ok:false, code:'not_started'}", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(409, { error: { code: "not_started", message: "conversation is not running" } }),
      ),
    );
    const result = await setCoderMode("c_1", "accept-edits", "sess1");
    expect(result).toEqual({
      ok: false,
      code: "not_started",
      message: "conversation is not running",
    });
  });
});

describe("steerCoder", () => {
  it("POSTs {input} to the steer endpoint and returns {ok:true} on 200", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await steerCoder("c_1", "go left", "sess1");

    expect(result).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("/api/coder/conversations/c_1/steer?session=sess1");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ input: "go left" });
  });

  it("maps a 409 no_turn body to {ok:false, code:'no_turn'}", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(409, { error: { code: "no_turn", message: "no turn is in progress" } }),
      ),
    );
    const result = await steerCoder("c_1", "go left", "sess1");
    expect(result).toEqual({
      ok: false,
      code: "no_turn",
      message: "no turn is in progress",
    });
  });
});

describe("queueCoder", () => {
  it("POSTs {input,sendId,queue:true} to /send and returns {ok,queued,position} on 202", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(202, { ok: true, queued: true, position: 2 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await queueCoder("c_1", "hi", "q_1", "sess1");

    expect(result).toEqual({ ok: true, queued: true, position: 2 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("/api/coder/conversations/c_1/send?session=sess1");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ input: "hi", sendId: "q_1", queue: true });
  });

  it("unwraps a double-enveloped {data:{...}} success body the same way", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(200, { data: { ok: true, queued: true, position: 1 } }),
      ),
    );
    const result = await queueCoder("c_1", "hi", "q_1", "sess1");
    expect(result).toEqual({ ok: true, queued: true, position: 1 });
  });

  it("maps a failure response to {ok:false, code}", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(409, { error: { code: "not_started", message: "conversation is not running" } }),
      ),
    );
    const result = await queueCoder("c_1", "hi", "q_1", "sess1");
    expect(result).toEqual({ ok: false, code: "not_started" });
  });

  it("maps a network failure to {ok:false, code:'network'}", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("boom")));
    const result = await queueCoder("c_1", "hi", "q_1", "sess1");
    expect(result).toEqual({ ok: false, code: "network" });
  });
});

describe("dequeueCoder", () => {
  it("DELETEs the queue entry and returns {ok,removed} on 200", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true, removed: true }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await dequeueCoder("c_1", "q_1", "sess1");

    expect(result).toEqual({ ok: true, removed: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("/api/coder/conversations/c_1/queue/q_1?session=sess1");
    expect(init.method).toBe("DELETE");
  });

  it("maps a failure response to {ok:false}", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(409, { error: { code: "not_started", message: "conversation is not running" } }),
      ),
    );
    const result = await dequeueCoder("c_1", "q_1", "sess1");
    expect(result).toEqual({ ok: false });
  });

  it("maps a network failure to {ok:false}", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("boom")));
    const result = await dequeueCoder("c_1", "q_1", "sess1");
    expect(result).toEqual({ ok: false });
  });
});

describe("needsInterruptedReplay (P3 Task 4 Fix B idempotency guard)", () => {
  it("needs a replay when no turn has been surfaced yet", () => {
    expect(needsInterruptedReplay("t_1", undefined)).toBe(true);
  });

  it("needs a replay for a NEW interrupted turnId, even after a prior one was surfaced", () => {
    expect(needsInterruptedReplay("t_2", "t_1")).toBe(true);
  });

  it("does NOT need a replay once this exact turnId was already surfaced — the fix for the duplicate-on-reload/self-heal finding", () => {
    expect(needsInterruptedReplay("t_1", "t_1")).toBe(false);
  });
});

describe("coder event extractors", () => {
  it("labels coder tool calls with the coder toolset map", () => {
    expect(
      toolLabel({
        kind: "event",
        event: { type: "ToolCall", payload: { function: { name: "Shell" } } },
      }),
    ).toBe("Running a command");
    expect(
      toolLabel({
        kind: "event",
        event: { type: "ToolCall", payload: { function: { name: "Mystery" } } },
      }),
    ).toBe("Running Mystery");
    expect(toolLabel({ kind: "end" })).toBeNull();
  });

  it("reads text parts and gates think extraction on payload.type === 'think'", () => {
    expect(
      textFromEvent({
        kind: "event",
        event: { type: "TextPart", payload: { text: "hey" } },
      }),
    ).toBe("hey");
    expect(
      thinkFromEvent({
        kind: "event",
        event: {
          type: "ContentPart",
          payload: { type: "think", think: "pondering" },
        },
      }),
    ).toBe("pondering");
    expect(
      thinkFromEvent({
        kind: "event",
        event: { type: "TextPart", payload: { text: "hey" } },
      }),
    ).toBeNull();
  });

  it("modeFromEvent reads permission_mode off a StatusUpdate, null otherwise", () => {
    expect(
      modeFromEvent({
        kind: "event",
        event: { type: "StatusUpdate", payload: { permission_mode: "plan" } },
      }),
    ).toBe("plan");
    expect(
      modeFromEvent({
        kind: "event",
        event: { type: "ToolCall", payload: { function: { name: "Shell" } } },
      }),
    ).toBeNull();
    expect(
      modeFromEvent({
        kind: "event",
        event: { type: "StatusUpdate", payload: { permission_mode: null } },
      }),
    ).toBeNull();
  });
});

describe("fetchCoderDiff", () => {
  it("GETs turnId as a query param and maps the diff fields on 200", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        nameStatus: [{ status: "A", path: "new.txt" }],
        patch: "diff --git a/new.txt b/new.txt\n...",
        truncated: false,
        filesChanged: 1,
        additions: 3,
        deletions: 0,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchCoderDiff("c_1", "t_1", undefined, "sess1");

    expect(result).toEqual({
      ok: true,
      nameStatus: [{ status: "A", path: "new.txt" }],
      patch: "diff --git a/new.txt b/new.txt\n...",
      truncated: false,
      filesChanged: 1,
      additions: 3,
      deletions: 0,
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(
      "/api/coder/conversations/c_1/diff?turnId=t_1&session=sess1",
    );
    expect(init).toBeUndefined();
  });

  it("includes path as a query param when given", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    vi.stubGlobal("fetch", fetchMock);

    await fetchCoderDiff("c_1", "t_1", "src/a.ts", "sess1");

    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(
      "/api/coder/conversations/c_1/diff?turnId=t_1&path=src%2Fa.ts&session=sess1",
    );
  });

  it("maps a 404 no_checkpoint body to {ok:false, code:'no_checkpoint'}", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(404, {
          error: { code: "no_checkpoint", message: "no checkpoint for this turn" },
        }),
      ),
    );
    const result = await fetchCoderDiff("c_1", "t_1", undefined, "sess1");
    expect(result).toEqual({ ok: false, code: "no_checkpoint" });
  });

  it("maps a network failure to {ok:false, code:'network'}", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("boom")));
    const result = await fetchCoderDiff("c_1", "t_1", undefined, "sess1");
    expect(result).toEqual({ ok: false, code: "network" });
  });

  it("unwraps the WRAPPED {data,meta} envelope the /diff proxy route actually produces — not just the raw shape the other cases here use (final-review fix: this boundary was previously only tested against the raw body)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          data: {
            nameStatus: [{ status: "M", path: "src/a.ts" }],
            patch: "diff --git a/src/a.ts b/src/a.ts\n...",
            truncated: false,
            filesChanged: 1,
            additions: 2,
            deletions: 1,
          },
          meta: { requestId: "req_123" },
        }),
      ),
    );
    const result = await fetchCoderDiff("c_1", "t_1", undefined, "sess1");
    expect(result).toEqual({
      ok: true,
      nameStatus: [{ status: "M", path: "src/a.ts" }],
      patch: "diff --git a/src/a.ts b/src/a.ts\n...",
      truncated: false,
      filesChanged: 1,
      additions: 2,
      deletions: 1,
    });
  });
});

describe("revertCoder", () => {
  it("POSTs {turnId} to the revert endpoint and maps the success fields", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        ok: true,
        safetyCheckpoint: "abc123",
        reverted: { turnId: "t_1" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await revertCoder("c_1", "t_1", "sess1");

    expect(result).toEqual({
      ok: true,
      safetyCheckpoint: "abc123",
      reverted: { turnId: "t_1" },
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("/api/coder/conversations/c_1/revert?session=sess1");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ turnId: "t_1" });
  });

  it("maps a 409 workspace_busy body to {ok:false, code:'workspace_busy'}", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(409, {
          error: { code: "workspace_busy", message: "a turn is running in this workspace" },
        }),
      ),
    );
    const result = await revertCoder("c_1", "t_1", "sess1");
    expect(result).toEqual({
      ok: false,
      code: "workspace_busy",
      message: "a turn is running in this workspace",
    });
  });

  it("maps a network failure to {ok:false, code:'network'}", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("boom")));
    const result = await revertCoder("c_1", "t_1", "sess1");
    expect(result).toEqual({
      ok: false,
      code: "network",
      message: "Network error — check your connection.",
    });
  });

  it("unwraps the WRAPPED {data,meta} envelope the /revert proxy route actually produces — not just the raw shape the other cases here use (final-review fix: this boundary was previously only tested against the raw body)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          data: { safetyCheckpoint: "def789", reverted: { turnId: "t_1" } },
          meta: { requestId: "req_456" },
        }),
      ),
    );
    const result = await revertCoder("c_1", "t_1", "sess1");
    expect(result).toEqual({
      ok: true,
      safetyCheckpoint: "def789",
      reverted: { turnId: "t_1" },
    });
  });
});

describe("hasFreshDiff (CheckpointFooter's ensureDiff re-fetch guard, final-review fix)", () => {
  it("null (never fetched) is not fresh", () => {
    expect(hasFreshDiff(null)).toBe(false);
  });

  it("a successful {ok:true} result is fresh", () => {
    expect(hasFreshDiff({ ok: true, patch: "" })).toBe(true);
  });

  it("a failed {ok:false} result is NOT fresh — this is the bug: fetchCoderDiff never throws, so a transient failure must still look re-fetchable to the next Review/Revert click", () => {
    expect(hasFreshDiff({ ok: false, code: "network" })).toBe(false);
  });
});
