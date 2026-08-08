import { describe, expect, it } from "vitest";
import { parseCsv } from "@/lib/terminal/csv";

describe("parseCsv", () => {
  it("parses simple rows", () => {
    expect(parseCsv("a,b,c\n1,2,3").rows).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("handles quoted fields with embedded commas, newlines, and escaped quotes", () => {
    const text = 'name,note\n"Doe, Jane","line1\nline2"\n"a ""quote""",x';
    expect(parseCsv(text).rows).toEqual([
      ["name", "note"],
      ["Doe, Jane", "line1\nline2"],
      ['a "quote"', "x"],
    ]);
  });

  it("treats CRLF like LF and drops blank lines but keeps empty quoted fields", () => {
    expect(parseCsv('a,b\r\n1,2\r\n\r\n"",z').rows).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["", "z"],
    ]);
  });

  it("keeps a final row with no trailing newline", () => {
    expect(parseCsv("x\ny").rows).toEqual([["x"], ["y"]]);
  });

  it("caps rows and reports truncation", () => {
    const text = Array.from({ length: 10 }, (_, i) => `r${i}`).join("\n");
    const { rows, truncated } = parseCsv(text, 4);
    expect(rows).toHaveLength(4);
    expect(truncated).toBe(true);
    expect(parseCsv("a\nb", 10).truncated).toBe(false);
  });
});
