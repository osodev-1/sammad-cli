import { describe, it, expect } from "vitest";
import { diffHunks, diffLines } from "@/lib/blueprint/diff";

describe("blueprint line diff", () => {
  it("marks added, removed and unchanged lines exactly", () => {
    const before = "a\nb\nc\n";
    const after = "a\nB\nc\nd\n";
    expect(diffLines(before, after)).toEqual([
      { kind: "same", text: "a" },
      { kind: "del", text: "b" },
      { kind: "add", text: "B" },
      { kind: "same", text: "c" },
      { kind: "add", text: "d" },
    ]);
  });

  it("identical texts produce zero hunks", () => {
    expect(diffHunks("x\ny\n", "x\ny\n")).toEqual([]);
  });

  it("hunks carry context and elide far-apart unchanged runs", () => {
    const before = Array.from({ length: 30 }, (_, i) => `line${i}`).join("\n");
    const after = before.replace("line2", "LINE2").replace("line27", "LINE27");
    const hunks = diffHunks(before, after, 2)!;
    expect(hunks).toHaveLength(2); // two changes far apart → two hunks
    expect(
      hunks[0].lines.some((l) => l.kind === "del" && l.text === "line2"),
    ).toBe(true);
    expect(
      hunks[1].lines.some((l) => l.kind === "add" && l.text === "LINE27"),
    ).toBe(true);
    // Elision: total kept lines are far fewer than the 30-line file.
    const total = hunks.reduce((n, h) => n + h.lines.length, 0);
    expect(total).toBeLessThan(16);
  });

  it("hunk line numbers anchor to the original texts", () => {
    const before = "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n";
    const after = "a\nb\nc\nd\ne\nf\ng\nh\ni\nJ\n";
    const [h] = diffHunks(before, after, 1)!;
    expect(h.beforeLine).toBe(9); // context starts at "i" (line 9)
    expect(h.afterLine).toBe(9);
  });

  it("falls back (null) on oversized inputs instead of freezing", () => {
    const big = Array.from({ length: 2001 }, (_, i) => `l${i}`).join("\n");
    expect(diffLines(big, "x")).toBeNull();
    expect(diffHunks(big, "x")).toBeNull();
  });
});
