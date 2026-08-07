/**
 * Pure client-side workspace model: entry kinds, tree shaping from the flat
 * snapshot, and artifact detection. DOM-free so it unit-tests in node.
 */

export interface WsEntry {
  name: string;
  path: string; // workspace-relative POSIX path
  kind: "dir" | "file";
  size: number;
  mtime: number; // seconds since epoch (server-side st_mtime)
}

export type FileKind =
  | "folder"
  | "image"
  | "pdf"
  | "zip"
  | "code"
  | "doc"
  | "data"
  | "file";

const EXT_KINDS: Record<string, FileKind> = {
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", svg: "image",
  pdf: "pdf",
  zip: "zip", tar: "zip", gz: "zip", tgz: "zip",
  md: "doc", mdx: "doc", txt: "doc", rst: "doc",
  doc: "doc", docx: "doc", xls: "data", xlsx: "data", ppt: "doc", pptx: "doc",
  json: "data", yaml: "data", yml: "data", csv: "data", toml: "data",
  js: "code", jsx: "code", ts: "code", tsx: "code", py: "code", rs: "code",
  go: "code", rb: "code", java: "code", c: "code", h: "code", cpp: "code",
  sh: "code", bash: "code", zsh: "code", css: "code", html: "code", htm: "code",
  sql: "code",
};

export function extension(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
}

export function fileKind(entry: Pick<WsEntry, "name" | "kind">): FileKind {
  if (entry.kind === "dir") return "folder";
  return EXT_KINDS[extension(entry.name)] ?? "file";
}

export type PreviewKind =
  | "markdown"
  | "code"
  | "json"
  | "csv"
  | "image"
  | "pdf"
  | "binary";

const CODE_EXTS = new Set([
  "js", "jsx", "ts", "tsx", "py", "rs", "go", "rb", "java", "c", "h", "cpp",
  "sh", "bash", "zsh", "css", "html", "htm", "sql", "toml", "yaml", "yml", "txt",
  "env", "ini", "cfg", "log", "xml", "rst",
]);

export function previewKind(name: string): PreviewKind {
  const ext = extension(name);
  if (ext === "md" || ext === "mdx") return "markdown";
  if (ext === "json") return "json";
  if (ext === "csv") return "csv";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext)) return "image";
  if (ext === "pdf") return "pdf";
  if (CODE_EXTS.has(ext) || ext === "") return "code";
  return "binary";
}

/** Text-editable = anything we render as text (markdown/code/json/csv). */
export function isTextEditable(name: string): boolean {
  return ["markdown", "code", "json", "csv"].includes(previewKind(name));
}

/** Renderable in the browser view (the sandboxed preview surface). */
export function isBrowserViewable(name: string): boolean {
  return ["html", "htm", "svg"].includes(extension(name));
}

/**
 * URL for the browser view. Workspace paths go through the sandboxed preview
 * route (per-segment encoded so relative assets resolve back through it);
 * absolute http(s) URLs pass through untouched — forward-compat with the
 * compute preview subdomains.
 */
export function previewUrl(pathOrUrl: string, sessionId?: string): string {
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  const encoded = pathOrUrl
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
  return withSession(`/api/workspace/preview/${encoded}`, sessionId);
}

/** Append the session scope to a workspace API url (handles ? vs &). */
export function withSession(url: string, sessionId?: string): string {
  if (!sessionId) return url;
  return `${url}${url.includes("?") ? "&" : "?"}session=${encodeURIComponent(sessionId)}`;
}

export interface TreeNode extends WsEntry {
  children: TreeNode[];
}

/** Shape the flat snapshot into a nested tree (dirs first, name-sorted). */
export function buildTree(entries: WsEntry[]): TreeNode[] {
  const byPath = new Map<string, TreeNode>();
  const roots: TreeNode[] = [];
  const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path));
  for (const entry of sorted) {
    const node: TreeNode = { ...entry, children: [] };
    byPath.set(entry.path, node);
    const slash = entry.path.lastIndexOf("/");
    if (slash === -1) {
      roots.push(node);
    } else {
      const parent = byPath.get(entry.path.slice(0, slash));
      if (parent) parent.children.push(node);
      else roots.push(node); // parent pruned (e.g. beyond snapshot cap)
    }
  }
  const sortLevel = (nodes: TreeNode[]): TreeNode[] => {
    nodes.sort((a, b) =>
      a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1
    );
    nodes.forEach((n) => sortLevel(n.children));
    return nodes;
  };
  return sortLevel(roots);
}

/**
 * Artifact detection (v1): files created or modified after `sinceEpochSeconds`,
 * newest first, excluding dotfiles at any level. Powers the Artifacts strip —
 * agent outputs surface as products, never as paths to copy.
 */
export function detectArtifacts(
  entries: WsEntry[],
  sinceEpochSeconds: number,
  limit = 12
): WsEntry[] {
  return entries
    .filter(
      (e) =>
        e.kind === "file" &&
        e.mtime >= sinceEpochSeconds &&
        !e.path.split("/").some((part) => part.startsWith("."))
    )
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
