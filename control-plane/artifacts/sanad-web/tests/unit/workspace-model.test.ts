import { describe, it, expect } from "vitest";
import {
  buildTree,
  detectArtifacts,
  fileKind,
  formatBytes,
  isTextEditable,
  previewKind,
  type WsEntry,
} from "@/lib/terminal/workspace-model";

const entry = (path: string, kind: "dir" | "file", mtime = 0, size = 10): WsEntry => ({
  name: path.split("/").pop() ?? path,
  path,
  kind,
  size,
  mtime,
});

describe("workspace model", () => {
  it("maps extensions to file kinds", () => {
    expect(fileKind(entry("a", "dir"))).toBe("folder");
    expect(fileKind(entry("x.png", "file"))).toBe("image");
    expect(fileKind(entry("x.pdf", "file"))).toBe("pdf");
    expect(fileKind(entry("x.zip", "file"))).toBe("zip");
    expect(fileKind(entry("x.ts", "file"))).toBe("code");
    expect(fileKind(entry("x.json", "file"))).toBe("data");
    expect(fileKind(entry("README.md", "file"))).toBe("doc");
    expect(fileKind(entry("mystery.xyz", "file"))).toBe("file");
  });

  it("chooses preview kinds and editability", () => {
    expect(previewKind("readme.md")).toBe("markdown");
    expect(previewKind("data.json")).toBe("json");
    expect(previewKind("rows.csv")).toBe("csv");
    expect(previewKind("pic.jpeg")).toBe("image");
    expect(previewKind("doc.pdf")).toBe("pdf");
    expect(previewKind("main.py")).toBe("code");
    expect(previewKind("archive.zip")).toBe("binary");
    expect(previewKind("Makefile")).toBe("code"); // no extension → text
    expect(isTextEditable("notes.md")).toBe(true);
    expect(isTextEditable("photo.png")).toBe(false);
  });

  it("builds a nested tree, dirs first, name-sorted", () => {
    const tree = buildTree([
      entry("b.txt", "file"),
      entry("docs", "dir"),
      entry("docs/z.md", "file"),
      entry("docs/a.md", "file"),
      entry("app", "dir"),
    ]);
    expect(tree.map((n) => n.name)).toEqual(["app", "docs", "b.txt"]);
    const docs = tree[1];
    expect(docs.children.map((c) => c.name)).toEqual(["a.md", "z.md"]);
  });

  it("keeps orphaned children visible when the parent was pruned", () => {
    const tree = buildTree([entry("deep/child.txt", "file")]);
    expect(tree).toHaveLength(1);
    expect(tree[0].path).toBe("deep/child.txt");
  });

  it("detects session artifacts: recent files, newest first, no dotfiles", () => {
    const artifacts = detectArtifacts(
      [
        entry("old.txt", "file", 100),
        entry("new-report.md", "file", 300),
        entry("newer.pdf", "file", 400),
        entry(".hidden/secret.txt", "file", 500),
        entry("dir-recent", "dir", 500),
      ],
      200
    );
    expect(artifacts.map((a) => a.path)).toEqual(["newer.pdf", "new-report.md"]);
  });

  it("formats byte counts", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});
