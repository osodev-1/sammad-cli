import { describe, it, expect } from "vitest";
import {
  ancestorDirs,
  buildTree,
  detectArtifacts,
  fileKind,
  formatBytes,
  isTextEditable,
  previewKind,
  type WsEntry,
} from "@/lib/terminal/workspace-model";

const entry = (
  path: string,
  kind: "dir" | "file",
  mtime = 0,
  size = 10,
): WsEntry => ({
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
    expect(previewKind("notes.ipynb")).toBe("notebook");
    expect(previewKind("archive.zip")).toBe("archive");
    expect(previewKind("bundle.tar.gz")).toBe("archive");
    expect(previewKind("data.tgz")).toBe("archive");
    expect(previewKind("solo.gz")).toBe("binary"); // a bare .gz is not a tar
    expect(previewKind("Makefile")).toBe("code"); // no extension → text
    expect(isTextEditable("notes.md")).toBe(true);
    expect(isTextEditable("photo.png")).toBe(false);
    expect(isTextEditable("archive.zip")).toBe(false);
    expect(isTextEditable("notes.ipynb")).toBe(false); // structured, read-only
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

  it("lists a path's ancestor dirs outermost-first, excluding the file", () => {
    expect(ancestorDirs(".sanad/skills/code-review/skill.yaml")).toEqual([
      ".sanad",
      ".sanad/skills",
      ".sanad/skills/code-review",
    ]);
    expect(ancestorDirs("top.txt")).toEqual([]); // no ancestors
    expect(ancestorDirs("a/b")).toEqual(["a"]);
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
      200,
    );
    expect(artifacts.map((a) => a.path)).toEqual([
      "newer.pdf",
      "new-report.md",
    ]);
  });

  it("formats byte counts", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});

describe("browser view helpers", () => {
  it("identifies browser-viewable files", async () => {
    const { isBrowserViewable } =
      await import("@/lib/terminal/workspace-model");
    expect(isBrowserViewable("index.html")).toBe(true);
    expect(isBrowserViewable("legacy.htm")).toBe(true);
    expect(isBrowserViewable("logo.svg")).toBe(true);
    expect(isBrowserViewable("main.py")).toBe(false);
    expect(isBrowserViewable("report.pdf")).toBe(false);
  });

  it("builds preview URLs with per-segment encoding; passes absolute URLs through", async () => {
    const { previewUrl } = await import("@/lib/terminal/workspace-model");
    expect(previewUrl("site/index.html")).toBe(
      "/api/workspace/preview/site/index.html",
    );
    expect(previewUrl("my site/a b.html")).toBe(
      "/api/workspace/preview/my%20site/a%20b.html",
    );
    expect(previewUrl("/leading/slash.html")).toBe(
      "/api/workspace/preview/leading/slash.html",
    );
    expect(previewUrl("https://x.example:3000/app")).toBe(
      "https://x.example:3000/app",
    );
  });
});
