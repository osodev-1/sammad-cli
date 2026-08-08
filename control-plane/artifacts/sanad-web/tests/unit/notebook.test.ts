import { describe, expect, it } from "vitest";
import { parseNotebook } from "@/lib/terminal/notebook";

describe("parseNotebook", () => {
  it("normalizes markdown + code cells and array sources", () => {
    const nb = parseNotebook(
      JSON.stringify({
        metadata: { language_info: { name: "python" } },
        cells: [
          { cell_type: "markdown", source: ["# Title\n", "text"] },
          {
            cell_type: "code",
            execution_count: 3,
            source: "print('hi')",
            outputs: [
              { output_type: "stream", name: "stdout", text: ["hi\n"] },
            ],
          },
        ],
      }),
    );
    expect(nb.error).toBeUndefined();
    expect(nb.language).toBe("python");
    expect(nb.cells).toHaveLength(2);
    expect(nb.cells[0]).toEqual({ type: "markdown", source: "# Title\ntext" });
    const code = nb.cells[1];
    expect(code.type).toBe("code");
    if (code.type === "code") {
      expect(code.executionCount).toBe(3);
      expect(code.source).toBe("print('hi')");
      expect(code.outputs).toEqual([
        { type: "stream", name: "stdout", text: "hi\n" },
      ]);
    }
  });

  it("extracts images, text/plain, and strips ANSI from tracebacks", () => {
    const nb = parseNotebook(
      JSON.stringify({
        cells: [
          {
            cell_type: "code",
            source: "",
            outputs: [
              {
                output_type: "display_data",
                data: { "image/png": "AAAABB==" },
              },
              { output_type: "execute_result", data: { "text/plain": "42" } },
              {
                output_type: "error",
                ename: "ValueError",
                traceback: ["[31mBoom[0m"],
              },
            ],
          },
        ],
      }),
    );
    const cell = nb.cells[0];
    expect(cell.type).toBe("code");
    if (cell.type === "code") {
      expect(cell.outputs[0]).toEqual({
        type: "image",
        dataUrl: "data:image/png;base64,AAAABB==",
      });
      expect(cell.outputs[1]).toEqual({ type: "text", text: "42" });
      expect(cell.outputs[2]).toEqual({ type: "error", text: "Boom" });
    }
  });

  it("prefers a richer mime and skips unknown outputs", () => {
    const nb = parseNotebook(
      JSON.stringify({
        cells: [
          {
            cell_type: "code",
            source: "x",
            outputs: [
              {
                output_type: "display_data",
                data: { "text/html": "<b>hi</b>", "text/plain": "hi" },
              },
              { output_type: "mystery" },
            ],
          },
        ],
      }),
    );
    const cell = nb.cells[0];
    if (cell.type === "code") {
      expect(cell.outputs).toEqual([{ type: "html", html: "<b>hi</b>" }]);
    }
  });

  it("degrades gracefully on non-notebook input (never throws)", () => {
    expect(parseNotebook("not json").error).toBeTruthy();
    expect(parseNotebook(JSON.stringify({ foo: 1 })).error).toBeTruthy();
    expect(parseNotebook("not json").cells).toEqual([]);
  });
});
