import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ensureConversation,
  sendCoder,
  fetchCoderTurn,
  respondCoder,
  setCoderMode,
  steerCoder,
  textFromEvent,
  thinkFromEvent,
  toolLabel,
  modeFromEvent,
  needsInterruptedReplay,
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
