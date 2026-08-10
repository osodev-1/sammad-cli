import { afterEach, describe, expect, it, vi } from "vitest";
import {
  askArchitect,
  planFromEvent,
  textFromEvent,
  toolLabel,
  type ArchitectItem,
} from "@/lib/architect/client";

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

afterEach(() => vi.unstubAllGlobals());

describe("architect stream parsing", () => {
  it("reassembles NDJSON items split across chunk boundaries", async () => {
    // The TextPart line is deliberately cut mid-JSON between the two chunks.
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          streamOf(
            '{"kind":"event","event":{"type":"TextPart","payload":{"text":"Hel',
            'lo"}}}\n{"kind":"end","status":"finished"}\n',
          ),
        ),
    );
    const items: ArchitectItem[] = [];
    await askArchitect("hi", "sess", (i) => items.push(i));

    expect(items).toHaveLength(2);
    expect(textFromEvent(items[0])).toBe("Hello");
    expect(items[1]).toEqual({ kind: "end", status: "finished" });
  });

  it("surfaces a non-2xx response as a single error item", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: { code: "busy", message: "a turn is in progress" },
          }),
          {
            status: 409,
            headers: { "content-type": "application/json" },
          },
        ),
      ),
    );
    const items: ArchitectItem[] = [];
    await askArchitect("hi", undefined, (i) => items.push(i));
    // The error code rides along so the panel can treat "busy" as queueable
    // (retry shortly) rather than a dead error.
    expect(items).toEqual([
      { kind: "error", code: "busy", message: "a turn is in progress" },
    ]);
  });
});

describe("event extractors", () => {
  it("pulls a drafted ChangePlan out of a ToolResult", () => {
    const item: ArchitectItem = {
      kind: "event",
      event: {
        type: "ToolResult",
        payload: {
          return_value: {
            extras: {
              blueprintPlan: {
                summary: "Create Skill",
                operations: [],
                preconditions: [],
                graphDelta: { nodesAdded: ["skill:x"], edgesAdded: [] },
              },
            },
          },
        },
      },
    };
    expect(planFromEvent(item)?.graphDelta.nodesAdded).toEqual(["skill:x"]);
    expect(planFromEvent({ kind: "end" })).toBeNull();
    expect(
      planFromEvent({
        kind: "event",
        event: { type: "TextPart", payload: { text: "hi" } },
      }),
    ).toBeNull();
  });

  it("labels tool calls and reads text parts", () => {
    expect(
      toolLabel({
        kind: "event",
        event: {
          type: "ToolCall",
          payload: { function: { name: "DraftBlueprintChange" } },
        },
      }),
    ).toBe("Drafting a change");
    expect(
      toolLabel({
        kind: "event",
        event: { type: "ToolCall", payload: { function: { name: "X" } } },
      }),
    ).toBe("Running X");
    expect(toolLabel({ kind: "end" })).toBeNull();
    expect(
      textFromEvent({
        kind: "event",
        event: { type: "TextPart", payload: { text: "hey" } },
      }),
    ).toBe("hey");
  });
});
