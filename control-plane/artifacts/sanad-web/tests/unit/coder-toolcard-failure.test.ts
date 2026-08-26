import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ToolCard } from "@/app/terminal/coder/ToolCard";
import type { CoderBlock } from "@/lib/coder/transcript";

/**
 * A failing tool call MUST be visible.
 *
 * Regression: failure used to be rendered per-card, and only ShellCard ever
 * read `result.isError`. A `WriteFile` that failed rendered exactly like one
 * that succeeded — just the path — so the agent would report writing a file,
 * the file would not exist, and the transcript showed nothing wrong. The only
 * hint was the checkpoint footer reading "0 files changed".
 *
 * `message` matters as much as the chip: kosong's `ToolError` only emits a
 * display block when given a `brief`, so a failed call routinely arrives with
 * `is_error: true` and an EMPTY `display`. Without `message` there is
 * literally nothing to show the user.
 *
 * Rendered with `renderToStaticMarkup` rather than Testing Library: this
 * suite runs in vitest's `node` environment and the assertions here are about
 * what reaches the DOM at all, not about interaction.
 */
type ToolBlock = Extract<CoderBlock, { kind: "tool" }>;

const tool = (
  name: string,
  result?: ToolBlock["result"],
  args: Record<string, unknown> = {},
): ToolBlock => ({
  kind: "tool",
  toolCallId: "call_1",
  name,
  label: `${name} call`,
  args,
  result,
});

const failed = (message?: string): ToolBlock["result"] => ({
  isError: true,
  message,
  display: [], // the realistic shape: ToolError with no `brief`
});

const render = (block: ToolBlock) =>
  renderToStaticMarkup(createElement(ToolCard, { block }));

describe("ToolCard — failure is never silent", () => {
  it("shows a failed chip AND the reason for a failed WriteFile", () => {
    const html = render(
      tool("WriteFile", failed("Permission denied: /data/workspace/script.js"), {
        path: "/data/workspace/script.js",
      }),
    );
    expect(html).toContain("failed");
    expect(html).toContain("Permission denied: /data/workspace/script.js");
  });

  it.each([
    "Shell",
    "WriteFile",
    "StrReplaceFile",
    "Grep",
    "Glob",
    "ReadFile",
    "SetTodoList",
    "SomeFutureTool",
  ])("surfaces failure for %s — no card type may swallow it", (name) => {
    const html = render(tool(name, failed("boom")));
    expect(html).toContain("failed");
    expect(html).toContain("boom");
  });

  it("renders the chip even when there is no message at all", () => {
    expect(render(tool("WriteFile", failed()))).toContain("failed");
  });

  it("does NOT mark a successful call as failed, and Shell keeps its done chip", () => {
    const ok: ToolBlock["result"] = { isError: false, display: [] };
    expect(render(tool("WriteFile", ok))).not.toContain("failed");
    const shell = render(tool("Shell", ok));
    expect(shell).toContain("done");
    expect(shell).not.toContain("failed");
  });

  it("shows no failure row while the call is still in flight", () => {
    expect(render(tool("WriteFile"))).not.toContain("failed");
  });
});
