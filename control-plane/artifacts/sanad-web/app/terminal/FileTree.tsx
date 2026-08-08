"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, DragEvent, MouseEvent } from "react";
import {
  ChevronRightIcon,
  FileCodeIcon,
  FileDataIcon,
  FileDocIcon,
  FileIcon,
  FileImageIcon,
  FileZipIcon,
  FolderIcon,
  FolderOpenIcon,
  PlusIcon,
  RefreshIcon,
  UploadIcon,
} from "../ui/icons";
import { input, type } from "../ui/theme";
import {
  ancestorDirs,
  fileKind,
  isBrowserViewable,
  type FileKind,
  type TreeNode,
} from "@/lib/terminal/workspace-model";
import { withSession } from "@/lib/terminal/workspace-model";

interface Props {
  sessionId?: string;
  tree: TreeNode[];
  busy: boolean;
  onOpenFile: (path: string) => void;
  /** Open in the sandboxed browser view (html/htm/svg, or a dir's index.html). */
  onOpenInBrowser: (path: string) => void;
  onRefresh: () => void;
  /** Perform a workspace mutation then refresh; errors surface as alerts. */
  onError: (message: string) => void;
  /**
   * Paths to reveal (expand their ancestor dirs) — a fresh array each time so a
   * repeated reveal still fires. After an apply writes e.g. a new skill's
   * manifests, this drills the tree open to them so they are visible at once.
   */
  revealPaths?: string[];
}

interface MenuState {
  x: number;
  y: number;
  node: TreeNode | null; // null = workspace root
}

function KindIcon({ kind, open }: { kind: FileKind; open?: boolean }) {
  const iconProps = { size: 15, strokeWidth: 1.6 };
  switch (kind) {
    case "folder":
      return open ? <FolderOpenIcon {...iconProps} /> : <FolderIcon {...iconProps} />;
    case "image":
      return <FileImageIcon {...iconProps} />;
    case "pdf":
    case "doc":
      return <FileDocIcon {...iconProps} />;
    case "zip":
      return <FileZipIcon {...iconProps} />;
    case "code":
      return <FileCodeIcon {...iconProps} />;
    case "data":
      return <FileDataIcon {...iconProps} />;
    default:
      return <FileIcon {...iconProps} />;
  }
}

async function api(path: string, init?: RequestInit): Promise<void> {
  const res = await fetch(path, init);
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error?.message ?? "Workspace request failed");
  }
}

export default function FileTree({
  sessionId,
  tree,
  busy,
  onOpenFile,
  onOpenInBrowser,
  onRefresh,
  onError,
  revealPaths,
}: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const uploadDir = useRef<string>("");

  /* Reveal just-written paths: expand each one's ancestor dirs so the files
     show even when they land inside collapsed folders (e.g. `.sanad/skills`).
     Keyed on the array's identity — the parent passes a fresh array per apply,
     so re-revealing the same path fires again. */
  useEffect(() => {
    if (!revealPaths || revealPaths.length === 0) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const p of revealPaths) {
        for (const dir of ancestorDirs(p)) next.add(dir);
      }
      return next;
    });
    setSelected(revealPaths[revealPaths.length - 1]);
  }, [revealPaths]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("blur", close);
    };
  }, [menu]);

  const run = useCallback(
    async (op: Promise<void>) => {
      try {
        await op;
        onRefresh();
      } catch (e) {
        onError(e instanceof Error ? e.message : "Workspace request failed");
      }
    },
    [onRefresh, onError]
  );

  const uploadFiles = useCallback(
    (dir: string, files: FileList | File[]) => {
      const list = Array.from(files);
      if (!list.length) return;
      const form = new FormData();
      for (const f of list) form.append("files", f);
      void run(
        api(withSession(`/api/workspace/upload?dir=${encodeURIComponent(dir)}`, sessionId), {
          method: "POST",
          body: form,
        })
      );
    },
    [run]
  );

  const onDrop = useCallback(
    (e: DragEvent, dir: string) => {
      e.preventDefault();
      e.stopPropagation();
      setDragOver(null);
      if (e.dataTransfer.files.length) uploadFiles(dir, e.dataTransfer.files);
    },
    [uploadFiles]
  );

  const openMenu = (e: MouseEvent, node: TreeNode | null) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, node });
    if (node) setSelected(node.path);
  };

  const startCreate = (dir: string, kind: "file" | "dir") => {
    const name = window.prompt(kind === "dir" ? "New folder name" : "New file name");
    if (!name) return;
    const path = dir ? `${dir}/${name}` : name;
    if (kind === "dir") {
      void run(
        api(withSession("/api/workspace/mkdir", sessionId), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path }),
        })
      );
    } else {
      void run(
        api(withSession(`/api/workspace/file?path=${encodeURIComponent(path)}`, sessionId), {
          method: "PUT",
          body: "",
        })
      );
    }
  };

  const commitRename = (node: TreeNode, newName: string) => {
    setRenaming(null);
    const trimmed = newName.trim();
    if (!trimmed || trimmed === node.name) return;
    const parent = node.path.includes("/")
      ? node.path.slice(0, node.path.lastIndexOf("/"))
      : "";
    const to = parent ? `${parent}/${trimmed}` : trimmed;
    void run(
      api(withSession("/api/workspace/move", sessionId), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ from: node.path, to }),
      })
    );
  };

  const doMove = (node: TreeNode) => {
    const to = window.prompt("Move to (new path)", node.path);
    if (!to || to === node.path) return;
    void run(
      api(withSession("/api/workspace/move", sessionId), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ from: node.path, to }),
      })
    );
  };

  const doDelete = (node: TreeNode) => {
    if (!window.confirm(`Delete ${node.name}? This cannot be undone.`)) return;
    void run(
      api(withSession(`/api/workspace/file?path=${encodeURIComponent(node.path)}`, sessionId), {
        method: "DELETE",
      })
    );
  };

  const download = (node: TreeNode) => {
    const url =
      node.kind === "dir"
        ? null
        : withSession(`/api/workspace/file?path=${encodeURIComponent(node.path)}&download=1`, sessionId);
    if (url) {
      window.open(url, "_blank");
      return;
    }
    // Folder → server-built ZIP.
    void (async () => {
      const res = await fetch(withSession("/api/workspace/archive", sessionId), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: node.path }),
      });
      if (!res.ok) {
        onError("Download failed");
        return;
      }
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${node.name}.zip`;
      a.click();
      URL.revokeObjectURL(a.href);
    })();
  };

  const matchesFilter = (node: TreeNode): boolean => {
    if (!filter) return true;
    if (node.name.toLowerCase().includes(filter.toLowerCase())) return true;
    return node.children.some(matchesFilter);
  };

  const renderNode = (node: TreeNode, depth: number) => {
    if (!matchesFilter(node)) return null;
    const isDir = node.kind === "dir";
    const isOpen = expanded.has(node.path) || Boolean(filter);
    const isSelected = selected === node.path;
    const isDropTarget = dragOver === node.path;

    return (
      <div key={node.path}>
        <div
          style={{
            ...s.row,
            paddingLeft: `${0.5 + depth * 0.85}rem`,
            ...(isSelected ? s.rowSelected : null),
            ...(isDropTarget ? s.rowDrop : null),
          }}
          onClick={() => {
            setSelected(node.path);
            if (isDir) {
              setExpanded((prev) => {
                const next = new Set(prev);
                if (next.has(node.path)) next.delete(node.path);
                else next.add(node.path);
                return next;
              });
            } else {
              onOpenFile(node.path);
            }
          }}
          onContextMenu={(e) => openMenu(e, node)}
          onDragOver={
            isDir
              ? (e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setDragOver(node.path);
                }
              : undefined
          }
          onDragLeave={isDir ? () => setDragOver(null) : undefined}
          onDrop={isDir ? (e) => onDrop(e, node.path) : undefined}
        >
          <span style={{ ...s.chevron, ...(isDir ? null : s.chevronHidden) }}>
            <ChevronRightIcon
              size={11}
              strokeWidth={2}
              style={{
                transform: isOpen ? "rotate(90deg)" : undefined,
                transition: "transform 0.12s ease",
              }}
            />
          </span>
          <KindIcon kind={fileKind(node)} open={isDir && isOpen} />
          {renaming === node.path ? (
            <input
              autoFocus
              defaultValue={node.name}
              style={s.renameInput}
              onClick={(e) => e.stopPropagation()}
              onBlur={(e) => commitRename(node, e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitRename(node, e.currentTarget.value);
                if (e.key === "Escape") setRenaming(null);
              }}
            />
          ) : (
            <span style={s.name}>{node.name}</span>
          )}
        </div>
        {isDir && isOpen && node.children.map((c) => renderNode(c, depth + 1))}
      </div>
    );
  };

  return (
    <div
      style={{ ...s.wrap, ...(dragOver === "" ? s.rowDrop : null) }}
      onContextMenu={(e) => openMenu(e, null)}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver("");
      }}
      onDragLeave={() => setDragOver(null)}
      onDrop={(e) => onDrop(e, "")}
    >
      <div style={s.toolbar}>
        <span style={s.toolbarTitle}>Files</span>
        <span style={s.toolbarActions}>
          <button
            title="New file"
            style={s.iconButton}
            onClick={() => startCreate(selected ?? "", "file")}
          >
            <PlusIcon size={14} strokeWidth={2} />
          </button>
          <button
            title="Upload files"
            style={s.iconButton}
            onClick={() => {
              uploadDir.current = "";
              fileInput.current?.click();
            }}
          >
            <UploadIcon size={14} strokeWidth={2} />
          </button>
          <button title="Refresh" style={s.iconButton} onClick={onRefresh}>
            <RefreshIcon size={14} strokeWidth={2} style={busy ? s.spin : undefined} />
          </button>
        </span>
      </div>
      <input
        style={s.filter}
        placeholder="Filter files"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      <div style={s.treeScroll}>
        {tree.length === 0 ? (
          <p style={s.empty}>
            Your workspace is empty. Drop files here, or ask the agent to create
            something.
          </p>
        ) : (
          tree.map((n) => renderNode(n, 0))
        )}
      </div>

      <input
        ref={fileInput}
        type="file"
        multiple
        style={{ display: "none" }}
        onChange={(e) => {
          if (e.target.files) uploadFiles(uploadDir.current, e.target.files);
          e.target.value = "";
        }}
      />

      {menu && (
        <div style={{ ...s.menu, left: menu.x, top: menu.y }}>
          {menu.node ? (
            <>
              {menu.node.kind === "dir" && (
                <>
                  <MenuItem
                    label="New file here"
                    onClick={() => startCreate(menu.node!.path, "file")}
                  />
                  <MenuItem
                    label="New folder here"
                    onClick={() => startCreate(menu.node!.path, "dir")}
                  />
                  <MenuItem
                    label="Upload here"
                    onClick={() => {
                      uploadDir.current = menu.node!.path;
                      fileInput.current?.click();
                    }}
                  />
                  {menu.node.children.some((c) => c.name === "index.html") && (
                    <MenuItem
                      label="Open in browser"
                      onClick={() => onOpenInBrowser(`${menu.node!.path}/index.html`)}
                    />
                  )}
                  <div style={s.menuRule} />
                </>
              )}
              {menu.node.kind === "file" && isBrowserViewable(menu.node.name) && (
                <MenuItem
                  label="Open in browser"
                  onClick={() => onOpenInBrowser(menu.node!.path)}
                />
              )}
              <MenuItem label="Rename" onClick={() => setRenaming(menu.node!.path)} />
              <MenuItem label="Move to…" onClick={() => doMove(menu.node!)} />
              <MenuItem label="Download" onClick={() => download(menu.node!)} />
              <div style={s.menuRule} />
              <MenuItem label="Delete" onClick={() => doDelete(menu.node!)} danger />
            </>
          ) : (
            <>
              <MenuItem label="New file" onClick={() => startCreate("", "file")} />
              <MenuItem label="New folder" onClick={() => startCreate("", "dir")} />
              <MenuItem
                label="Upload files"
                onClick={() => {
                  uploadDir.current = "";
                  fileInput.current?.click();
                }}
              />
              <MenuItem label="Refresh" onClick={onRefresh} />
            </>
          )}
        </div>
      )}
    </div>
  );
}

function MenuItem({
  label,
  onClick,
  danger,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      style={{ ...s.menuItem, ...(danger ? s.menuItemDanger : null) }}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

const s: Record<string, CSSProperties> = {
  wrap: {
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
    height: "100%",
    borderRight: "1px solid var(--rule)",
    background: "var(--paper)",
  },
  toolbar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "0.65rem 0.75rem 0.4rem",
  },
  toolbarTitle: { ...type.eyebrow },
  toolbarActions: { display: "inline-flex", gap: "0.2rem" },
  iconButton: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "26px",
    height: "26px",
    border: "none",
    background: "none",
    borderRadius: "var(--radius-sm)",
    color: "var(--ink-muted)",
    cursor: "pointer",
  },
  spin: { animation: "spin 1s linear infinite" },
  filter: {
    ...input,
    borderRadius: "var(--radius-sm)",
    margin: "0 0.75rem 0.5rem",
    padding: "0.35rem 0.7rem",
    fontSize: "0.78rem",
  },
  treeScroll: {
    flex: 1,
    minHeight: 0,
    overflowY: "auto",
    paddingBottom: "0.75rem",
  },
  row: {
    display: "flex",
    alignItems: "center",
    gap: "0.4rem",
    padding: "0.22rem 0.5rem",
    fontSize: "0.82rem",
    color: "var(--ink-soft)",
    cursor: "pointer",
    userSelect: "none",
    whiteSpace: "nowrap",
  },
  rowSelected: { background: "var(--rule)", color: "var(--ink)" },
  rowDrop: { outline: "1.5px dashed var(--ink)", outlineOffset: "-1.5px" },
  chevron: { display: "inline-flex", width: "11px", color: "var(--ink-muted)" },
  chevronHidden: { visibility: "hidden" },
  name: { overflow: "hidden", textOverflow: "ellipsis" },
  renameInput: {
    ...input,
    borderRadius: "var(--radius-sm)",
    padding: "0.1rem 0.4rem",
    fontSize: "0.8rem",
  },
  empty: {
    ...type.small,
    padding: "1rem 0.9rem",
    lineHeight: 1.6,
  },
  menu: {
    position: "fixed",
    zIndex: 300,
    minWidth: "170px",
    background: "var(--paper)",
    border: "1px solid var(--rule-strong)",
    borderRadius: "var(--radius-md)",
    boxShadow: "var(--shadow-soft)",
    padding: "0.3rem",
    display: "flex",
    flexDirection: "column",
  },
  menuItem: {
    textAlign: "left",
    background: "none",
    border: "none",
    borderRadius: "var(--radius-sm)",
    padding: "0.45rem 0.7rem",
    fontSize: "0.82rem",
    color: "var(--ink)",
    cursor: "pointer",
  },
  menuItemDanger: { fontWeight: 700 },
  menuRule: {
    borderTop: "1px solid var(--rule)",
    margin: "0.25rem 0.4rem",
  },
};
