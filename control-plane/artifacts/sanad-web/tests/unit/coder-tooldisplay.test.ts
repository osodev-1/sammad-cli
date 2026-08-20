import { describe, it, expect } from "vitest";
import { parseToolArgs, toolActionLabel, normalizeDisplay } from "@/lib/coder/toolDisplay";

describe("parseToolArgs", () => {
  it("parses a valid JSON object string", () => {
    expect(parseToolArgs("Shell", '{"command":"ls -la"}')).toEqual({ command: "ls -la" });
  });

  it("returns {} for null, malformed, and undefined input — never throws", () => {
    expect(parseToolArgs("Shell", null)).toEqual({});
    expect(parseToolArgs("Shell", "{")).toEqual({});
    expect(parseToolArgs("Shell", undefined)).toEqual({});
  });

  it("returns {} when the JSON is valid but not an object (e.g. an array or scalar)", () => {
    expect(parseToolArgs("Shell", "[1,2,3]")).toEqual({});
    expect(parseToolArgs("Shell", "42")).toEqual({});
    expect(parseToolArgs("Shell", "null")).toEqual({});
  });
});

describe("toolActionLabel", () => {
  it("Shell: Run `<command>` (contains the command)", () => {
    const label = toolActionLabel("Shell", { command: "npm run build" });
    expect(label).toContain("npm run build");
  });

  it("Shell: clips a long command to ~80 chars", () => {
    const longCommand = "x".repeat(200);
    const label = toolActionLabel("Shell", { command: longCommand });
    expect(label.length).toBeLessThan(120);
  });

  it("WriteFile: Edit <path>", () => {
    expect(toolActionLabel("WriteFile", { path: "a/b.ts" })).toBe("Edit a/b.ts");
  });

  it("StrReplaceFile: Edit <path>", () => {
    expect(toolActionLabel("StrReplaceFile", { path: "a/b.ts" })).toBe("Edit a/b.ts");
  });

  it("ReadFile: Read <path>", () => {
    expect(toolActionLabel("ReadFile", { path: "a/b.ts" })).toBe("Read a/b.ts");
  });

  it("Grep: contains the pattern", () => {
    expect(toolActionLabel("Grep", { pattern: "foo" })).toContain("foo");
  });

  it("Glob: contains the pattern", () => {
    expect(toolActionLabel("Glob", { pattern: "**/*.ts" })).toContain("**/*.ts");
  });

  it("falls back to the generic map's phrase when args are missing", () => {
    expect(toolActionLabel("Shell", {})).toBe("Running a command");
    expect(toolActionLabel("SetTodoList", {})).toBe("Updating the plan");
  });

  it("unknown tool name -> Running X", () => {
    expect(toolActionLabel("SomeUnknownTool", {})).toBe("Running SomeUnknownTool");
  });
});

describe("normalizeDisplay", () => {
  it("keeps well-formed blocks and drops malformed ones", () => {
    const result = normalizeDisplay([
      { type: "shell", language: "bash", command: "ls" },
      { type: "diff", path: "f", old_text: "a", new_text: "b" },
      { bogus: 1 },
    ]);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ type: "shell", command: "ls" });
    expect(result[1]).toMatchObject({ type: "diff", path: "f", old_text: "a", new_text: "b" });
  });

  it("returns [] for non-array input, never throws", () => {
    expect(normalizeDisplay(undefined)).toEqual([]);
    expect(normalizeDisplay(null)).toEqual([]);
    expect(normalizeDisplay("nope")).toEqual([]);
    expect(normalizeDisplay({ not: "an array" })).toEqual([]);
  });

  it("normalizes a todo block, dropping malformed items", () => {
    const result = normalizeDisplay([
      {
        type: "todo",
        items: [
          { title: "write tests", status: "done" },
          { title: "bad status", status: "nope" },
          { noTitle: true },
        ],
      },
    ]);
    expect(result).toEqual([
      { type: "todo", items: [{ title: "write tests", status: "done" }] },
    ]);
  });

  it("passes through an unrecognized-but-well-formed type as an unknown block", () => {
    const result = normalizeDisplay([{ type: "mystery", data: { a: 1 } }]);
    expect(result).toEqual([{ type: "mystery", data: { a: 1 } }]);
  });

  it("drops a shell block missing its required command field", () => {
    expect(normalizeDisplay([{ type: "shell", language: "bash" }])).toEqual([]);
  });
});
