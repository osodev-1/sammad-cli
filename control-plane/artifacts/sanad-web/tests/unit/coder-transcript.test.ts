import { describe, it, expect } from "vitest";
import {
  reduce,
  toStored,
  fromStored,
  type CoderBlock,
  type CoderMessage,
} from "@/lib/coder/transcript";
import type { CoderItem } from "@/lib/coder/types";

const approvalRequest = (requestId: string): CoderItem => ({
  kind: "request",
  requestId,
  requestType: "approval",
  turnId: "t1",
  request: {
    id: requestId,
    action: "run command",
    description: "rm -rf build/",
  },
});

const questionRequest = (requestId: string): CoderItem => ({
  kind: "request",
  requestId,
  requestType: "question",
  turnId: "t1",
  request: {
    id: requestId,
    questions: [{ question: "Which package manager?", options: [{ label: "pnpm" }] }],
  },
});

describe("coder transcript fold (reduce)", () => {
  const toolEvent = (name: string): CoderItem => ({
    kind: "event",
    event: { type: "ToolCall", payload: { function: { name } } },
  });

  it("pending -> resolved: block replaced in place, order stable", () => {
    let blocks: CoderBlock[] = [];
    blocks = reduce(blocks, toolEvent("Grep"));
    blocks = reduce(blocks, approvalRequest("r1"));
    blocks = reduce(blocks, toolEvent("Glob"));
    expect(blocks.map((b) => b.kind)).toEqual(["tool", "request", "tool"]);

    blocks = reduce(blocks, {
      kind: "request_resolved",
      requestId: "r1",
      requestType: "approval",
      resolution: { response: "approve" },
    });
    expect(blocks.map((b) => b.kind)).toEqual(["tool", "request", "tool"]);
    const req = blocks[1];
    expect(req.kind === "request" && req.state).toBe("resolved");
    expect(req.kind === "request" && req.resolution).toEqual({ response: "approve" });
  });

  it("question request folds and resolves with its answers in `resolution`", () => {
    let blocks: CoderBlock[] = reduce([], questionRequest("r1"));
    expect(blocks[0].kind === "request" && blocks[0].requestType).toBe("question");
    blocks = reduce(blocks, {
      kind: "request_resolved",
      requestId: "r1",
      requestType: "question",
      resolution: { answers: { q1: "pnpm" } },
    });
    expect(blocks[0].kind === "request" && blocks[0].state).toBe("resolved");
    expect(blocks[0].kind === "request" && blocks[0].resolution).toEqual({
      answers: { q1: "pnpm" },
    });
  });

  it("pending -> cancelled", () => {
    let blocks: CoderBlock[] = reduce([], approvalRequest("r1"));
    blocks = reduce(blocks, { kind: "request_cancelled", requestId: "r1", reason: "turn cancelled" });
    const req = blocks[0];
    expect(req.kind === "request" && req.state).toBe("cancelled");
  });

  it("cancelled -> resolved upgrades (LAST-WINS)", () => {
    let blocks: CoderBlock[] = reduce([], approvalRequest("r1"));
    blocks = reduce(blocks, { kind: "request_cancelled", requestId: "r1", reason: "x" });
    expect(blocks[0].kind === "request" && blocks[0].state).toBe("cancelled");
    blocks = reduce(blocks, {
      kind: "request_resolved",
      requestId: "r1",
      requestType: "approval",
      resolution: { response: "approve" },
    });
    expect(blocks[0].kind === "request" && blocks[0].state).toBe("resolved");
    expect(blocks[0].kind === "request" && blocks[0].resolution).toEqual({ response: "approve" });
  });

  it("resolved -> cancelled attempt is ignored", () => {
    let blocks: CoderBlock[] = reduce([], approvalRequest("r1"));
    blocks = reduce(blocks, {
      kind: "request_resolved",
      requestId: "r1",
      requestType: "approval",
      resolution: { response: "reject" },
    });
    expect(blocks[0].kind === "request" && blocks[0].state).toBe("resolved");
    const before = blocks;
    blocks = reduce(blocks, { kind: "request_cancelled", requestId: "r1", reason: "late" });
    expect(blocks[0].kind === "request" && blocks[0].state).toBe("resolved");
    expect(blocks).toEqual(before);
  });

  it("duplicate `request` item replay replaces in place, no duplicate block", () => {
    let blocks: CoderBlock[] = reduce([], approvalRequest("r1"));
    blocks = reduce(blocks, toolEvent("Grep"));
    blocks = reduce(blocks, approvalRequest("r1")); // journal replay of the same request
    expect(blocks.map((b) => b.kind)).toEqual(["request", "tool"]);
    expect(blocks.filter((b) => b.kind === "request")).toHaveLength(1);
    expect(blocks[0].kind === "request" && blocks[0].state).toBe("pending");
  });

  it("`request` replay after request_resolved is ignored — decided block stays frozen", () => {
    let blocks: CoderBlock[] = reduce([], approvalRequest("r1"));
    blocks = reduce(blocks, {
      kind: "request_resolved",
      requestId: "r1",
      requestType: "approval",
      resolution: { response: "approve" },
    });
    const before = blocks;
    blocks = reduce(blocks, approvalRequest("r1")); // stale journal replay of the original request
    expect(blocks).toEqual(before);
    expect(blocks[0].kind === "request" && blocks[0].state).toBe("resolved");
    expect(blocks[0].kind === "request" && blocks[0].resolution).toEqual({ response: "approve" });
  });

  it("`request` replay after request_cancelled is ignored — cancelled block stays frozen", () => {
    let blocks: CoderBlock[] = reduce([], approvalRequest("r1"));
    blocks = reduce(blocks, { kind: "request_cancelled", requestId: "r1", reason: "turn cancelled" });
    const before = blocks;
    blocks = reduce(blocks, approvalRequest("r1")); // stale journal replay of the original request
    expect(blocks).toEqual(before);
    expect(blocks[0].kind === "request" && blocks[0].state).toBe("cancelled");
  });

  it("unknown requestId on resolve/cancel appends nothing, returns blocks unchanged", () => {
    const blocks: CoderBlock[] = reduce([], approvalRequest("r1"));
    const afterResolve = reduce(blocks, {
      kind: "request_resolved",
      requestId: "does-not-exist",
      requestType: "approval",
      resolution: { response: "approve" },
    });
    expect(afterResolve).toEqual(blocks);
    const afterCancel = reduce(blocks, {
      kind: "request_cancelled",
      requestId: "does-not-exist",
    });
    expect(afterCancel).toEqual(blocks);
  });

  it("items after `end` still fold", () => {
    let blocks: CoderBlock[] = reduce([], approvalRequest("r1"));
    blocks = reduce(blocks, { kind: "end", status: "finished" });
    expect(blocks[0].kind === "request" && blocks[0].state).toBe("pending");
    blocks = reduce(blocks, { kind: "request_cancelled", requestId: "r1", reason: "post-end" });
    expect(blocks[0].kind === "request" && blocks[0].state).toBe("cancelled");
  });

  it("think/text coalesce into a trailing block of the same kind", () => {
    let blocks: CoderBlock[] = [];
    const thinkItem = (t: string): CoderItem => ({
      kind: "event",
      event: { type: "content", payload: { type: "think", think: t } },
    });
    const textItem = (t: string): CoderItem => ({
      kind: "event",
      event: { type: "content", payload: { text: t } },
    });
    blocks = reduce(blocks, thinkItem("Let me "));
    blocks = reduce(blocks, thinkItem("check the file."));
    expect(blocks).toEqual([{ kind: "think", text: "Let me check the file." }]);

    blocks = reduce(blocks, textItem("Here's "));
    blocks = reduce(blocks, textItem("the answer."));
    expect(blocks).toEqual([
      { kind: "think", text: "Let me check the file." },
      { kind: "text", text: "Here's the answer." },
    ]);
  });

  it("consecutive identical tool labels dedupe", () => {
    const toolItem = (name: string): CoderItem => ({
      kind: "event",
      event: { type: "ToolCall", payload: { function: { name } } },
    });
    let blocks: CoderBlock[] = [];
    blocks = reduce(blocks, toolItem("Grep"));
    blocks = reduce(blocks, toolItem("Grep"));
    expect(blocks).toEqual([{ kind: "tool", label: "Searching files" }]);
    blocks = reduce(blocks, toolItem("Glob"));
    expect(blocks).toEqual([
      { kind: "tool", label: "Searching files" },
      { kind: "tool", label: "Finding files" },
    ]);
  });

  it("error with code !== busy appends a warning text block; busy errors are silent", () => {
    let blocks: CoderBlock[] = [];
    blocks = reduce(blocks, { kind: "error", code: "busy", message: "hold on" });
    expect(blocks).toEqual([]);
    blocks = reduce(blocks, { kind: "error", code: "network", message: "Network error." });
    expect(blocks).toEqual([{ kind: "text", text: "⚠ Network error." }]);
  });

  it("RequestOutcome events are not rendered (extractors return null; no block change)", () => {
    const outcomeItem: CoderItem = {
      kind: "event",
      event: { type: "RequestOutcome", payload: { requestId: "r1", outcome: "approve" } },
    };
    expect(reduce([], outcomeItem)).toEqual([]);
    const existing: CoderBlock[] = [{ kind: "text", text: "hi" }];
    expect(reduce(existing, outcomeItem)).toEqual(existing);
  });
});

describe("coder transcript persistence (toStored / fromStored)", () => {
  it("drops think blocks and ⚠-prefixed text, downgrades a pending request to cancelled", () => {
    const live: CoderMessage[] = [
      { role: "user", text: "fix the bug" },
      {
        role: "assistant",
        blocks: [
          { kind: "think", text: "reasoning..." },
          { kind: "text", text: "⚠ Network error — check your connection." },
          { kind: "text", text: "I'll fix it." },
          { kind: "tool", label: "Editing a file" },
          {
            kind: "request",
            requestId: "r1",
            requestType: "approval",
            payload: { id: "r1", action: "run command", description: "rm -rf build/" },
            state: "pending",
          },
        ],
      },
    ];
    const stored = toStored(live);
    expect(stored[0]).toEqual({ role: "user", text: "fix the bug" });
    const blocks = stored[1].role === "assistant" ? stored[1].blocks : [];
    expect(blocks).toEqual([
      { kind: "text", text: "I'll fix it." },
      { kind: "tool", label: "Editing a file" },
      {
        kind: "request",
        requestId: "r1",
        requestType: "approval",
        summary: "run command: rm -rf build/",
        state: "cancelled",
      },
    ]);
  });

  it("resolved approval keeps its response as outcome; resolved question gets an answers digest", () => {
    const live: CoderMessage[] = [
      {
        role: "assistant",
        blocks: [
          {
            kind: "request",
            requestId: "r1",
            requestType: "approval",
            payload: { id: "r1", action: "run command", description: "npm test" },
            state: "resolved",
            resolution: { response: "approve" },
          },
          {
            kind: "request",
            requestId: "r2",
            requestType: "question",
            payload: {
              id: "r2",
              questions: [{ question: "Pick one", options: [] }],
            },
            state: "resolved",
            resolution: { answers: { q1: "pnpm", q2: "yes" } },
          },
        ],
      },
    ];
    const stored = toStored(live);
    const blocks = stored[0].role === "assistant" ? stored[0].blocks : [];
    expect(blocks[0]).toEqual({
      kind: "request",
      requestId: "r1",
      requestType: "approval",
      summary: "run command: npm test",
      state: "resolved",
      outcome: "approve",
    });
    expect(blocks[1]).toEqual({
      kind: "request",
      requestId: "r2",
      requestType: "question",
      summary: "Pick one",
      state: "resolved",
      outcome: "pnpm, yes",
    });
  });

  it("round-trips through fromStored with requests inert (no live payload) and read-only", () => {
    const live: CoderMessage[] = [
      { role: "user", text: "hi" },
      {
        role: "assistant",
        blocks: [
          {
            kind: "request",
            requestId: "r1",
            requestType: "approval",
            payload: { id: "r1", action: "run command", description: "npm test" },
            state: "resolved",
            resolution: { response: "approve" },
          },
        ],
      },
    ];
    const restored = fromStored(toStored(live));
    const block = restored[1].role === "assistant" ? restored[1].blocks[0] : null;
    expect(block && block.kind === "request" && block.state).toBe("resolved");
    // The restored payload is a synthetic placeholder, never the original request.
    expect(block && block.kind === "request" && block.payload).not.toEqual(
      live[1].role === "assistant" && live[1].blocks[0].kind === "request"
        ? live[1].blocks[0].payload
        : undefined,
    );
  });

  it("caps message count at 60 (61 -> 60, keeping the newest)", () => {
    const many: CoderMessage[] = Array.from({ length: 61 }, (_, i) => ({
      role: "user" as const,
      text: `m${i}`,
    }));
    const stored = toStored(many);
    expect(stored).toHaveLength(60);
    const first = stored[0];
    expect(first.role === "user" && first.text).toBe("m1"); // m0 dropped
    const last = stored[stored.length - 1];
    expect(last.role === "user" && last.text).toBe("m60");
  });

  it("truncates a 6001-char assistant text block to the 6000-char cap", () => {
    const live: CoderMessage[] = [
      {
        role: "assistant",
        blocks: [{ kind: "text", text: "x".repeat(6001) }],
      },
    ];
    const stored = toStored(live);
    const blocks = stored[0].role === "assistant" ? stored[0].blocks : [];
    expect(blocks[0].kind === "text" && blocks[0].text.length).toBe(6000);
    expect(blocks[0].kind === "text" && blocks[0].text.endsWith("…")).toBe(true);
  });

  it("caps blocks per assistant message at 80", () => {
    const blocks: CoderBlock[] = Array.from({ length: 90 }, (_, i) => ({
      kind: "tool" as const,
      label: `step ${i}`,
    }));
    const stored = toStored([{ role: "assistant", blocks }]);
    const storedBlocks = stored[0].role === "assistant" ? stored[0].blocks : [];
    expect(storedBlocks).toHaveLength(80);
  });
});
