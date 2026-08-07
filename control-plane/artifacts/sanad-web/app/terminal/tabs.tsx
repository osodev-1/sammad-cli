"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { CrossOutlineIcon, DownloadIcon, GlobeIcon } from "../ui/icons";
import { button, size, type } from "../ui/theme";
import {
  isTextEditable,
  previewKind,
  formatBytes,
} from "@/lib/terminal/workspace-model";
import { withSession } from "@/lib/terminal/workspace-model";

/* ------------------------------------------------------------- tabs bar --- */

export interface WorkspaceTab {
  path: string;
  name: string;
}

export interface TerminalTabInfo {
  id: string;
  label: string;
}

export interface BrowserTab {
  id: string; // "view-N"
  url: string; // workspace path or absolute http(s) URL
  title: string;
}

export function TabsBar({
  terminals,
  viewTabs,
  fileTabs,
  active,
  canAddTerminal,
  onSelect,
  onCloseFile,
  onCloseTerminal,
  onCloseView,
  onNewTerminal,
}: {
  terminals: TerminalTabInfo[];
  viewTabs: BrowserTab[];
  fileTabs: WorkspaceTab[];
  active: string;
  canAddTerminal: boolean;
  onSelect: (id: string) => void;
  onCloseFile: (path: string) => void;
  onCloseTerminal: (id: string) => void;
  onCloseView: (id: string) => void;
  onNewTerminal: () => void;
}) {
  return (
    <div style={s.tabsBar}>
      {terminals.map((t) => (
        <Tab
          key={t.id}
          label={t.label}
          active={active === t.id}
          onSelect={() => onSelect(t.id)}
          onClose={terminals.length > 1 ? () => onCloseTerminal(t.id) : undefined}
        />
      ))}
      {canAddTerminal && (
        <button
          style={s.addTerminal}
          title="New terminal"
          aria-label="New terminal"
          onClick={onNewTerminal}
        >
          +
        </button>
      )}
      {viewTabs.map((t) => (
        <Tab
          key={t.id}
          label={t.title}
          icon={<GlobeIcon size={12} strokeWidth={1.8} />}
          active={active === t.id}
          onSelect={() => onSelect(t.id)}
          onClose={() => onCloseView(t.id)}
        />
      ))}
      {fileTabs.map((t) => (
        <Tab
          key={t.path}
          label={t.name}
          active={active === t.path}
          onSelect={() => onSelect(t.path)}
          onClose={() => onCloseFile(t.path)}
        />
      ))}
    </div>
  );
}

function Tab({
  label,
  icon,
  active,
  onSelect,
  onClose,
}: {
  label: string;
  icon?: ReactNode;
  active: boolean;
  onSelect: () => void;
  onClose?: () => void;
}) {
  return (
    <span
      style={{ ...s.tab, ...(active ? s.tabActive : null) }}
      onClick={onSelect}
      onAuxClick={(e) => {
        if (e.button === 1) onClose?.();
      }}
    >
      {icon}
      <span style={s.tabLabel}>{label}</span>
      {onClose && (
        <button
          style={s.tabClose}
          aria-label={`Close ${label}`}
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
        >
          <CrossOutlineIcon size={11} strokeWidth={2} />
        </button>
      )}
    </span>
  );
}

/* -------------------------------------------------------------- preview --- */

type LoadState =
  | { tag: "loading" }
  | { tag: "text"; content: string }
  | { tag: "blob"; url: string; sizeLabel: string }
  | { tag: "error"; message: string };

export function FilePreview({ path, sessionId }: { path: string; sessionId?: string }) {
  const name = path.split("/").pop() ?? path;
  const kind = previewKind(name);
  const editable = isTextEditable(name);
  const [state, setState] = useState<LoadState>({ tag: "loading" });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [rendered, setRendered] = useState<string | null>(null); // markdown HTML

  const fileUrl = withSession(`/api/workspace/file?path=${encodeURIComponent(path)}`, sessionId);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setState({ tag: "loading" });
    setEditing(false);
    setDirty(false);
    setRendered(null);

    (async () => {
      const res = await fetch(fileUrl);
      if (cancelled) return;
      if (!res.ok) {
        setState({ tag: "error", message: "Could not open this file." });
        return;
      }
      if (kind === "image" || kind === "pdf" || kind === "binary") {
        const blob = await res.blob();
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setState({ tag: "blob", url: objectUrl, sizeLabel: formatBytes(blob.size) });
      } else {
        const text = await res.text();
        if (cancelled) return;
        setState({ tag: "text", content: text });
        setDraft(text);
        if (kind === "markdown") {
          const [{ marked }, { default: DOMPurify }] = await Promise.all([
            import("marked"),
            import("dompurify"),
          ]);
          if (cancelled) return;
          const html = DOMPurify.sanitize(await marked.parse(text));
          setRendered(html);
        }
      }
    })().catch(() => {
      if (!cancelled) setState({ tag: "error", message: "Could not open this file." });
    });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [fileUrl, kind]);

  const save = useCallback(async () => {
    setSaving(true);
    try {
      const res = await fetch(fileUrl, { method: "PUT", body: draft });
      if (!res.ok) throw new Error();
      setDirty(false);
      setState({ tag: "text", content: draft });
      if (kind === "markdown") {
        const [{ marked }, { default: DOMPurify }] = await Promise.all([
          import("marked"),
          import("dompurify"),
        ]);
        setRendered(DOMPurify.sanitize(await marked.parse(draft)));
      }
    } catch {
      window.alert("Save failed — try again.");
    } finally {
      setSaving(false);
    }
  }, [draft, fileUrl, kind]);

  const body = useMemo(() => {
    switch (state.tag) {
      case "loading":
        return <p style={s.meta}>Opening…</p>;
      case "error":
        return <p style={s.meta}>{state.message}</p>;
      case "blob":
        if (kind === "image") {
          return <img src={state.url} alt={name} style={s.image} />;
        }
        if (kind === "pdf") {
          return <iframe src={state.url} title={name} style={s.pdf} />;
        }
        return (
          <div style={s.binaryCard}>
            <p style={s.meta}>
              {name} · {state.sizeLabel}
            </p>
            <a href={`${fileUrl}&download=1`} style={button.secondary(size.sm)}>
              <DownloadIcon size={14} strokeWidth={2} />
              Download
            </a>
          </div>
        );
      case "text": {
        if (editing) {
          return (
            <textarea
              style={s.editor}
              value={draft}
              spellCheck={false}
              onChange={(e) => {
                setDraft(e.target.value);
                setDirty(true);
              }}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "s") {
                  e.preventDefault();
                  void save();
                }
              }}
            />
          );
        }
        if (kind === "markdown" && rendered !== null) {
          return (
            <div
              style={s.markdown}
              // Sanitized with DOMPurify above.
              dangerouslySetInnerHTML={{ __html: rendered }}
            />
          );
        }
        if (kind === "json") {
          let pretty = state.content;
          try {
            pretty = JSON.stringify(JSON.parse(state.content), null, 2);
          } catch {
            /* show raw */
          }
          return <pre style={s.code}>{pretty}</pre>;
        }
        if (kind === "csv") {
          return <CsvTable content={state.content} />;
        }
        return <pre style={s.code}>{state.content}</pre>;
      }
    }
  }, [state, editing, draft, rendered, kind, name, fileUrl, save]);

  return (
    <div style={s.previewWrap}>
      <div style={s.previewToolbar}>
        <span style={s.previewPath}>{path}</span>
        <span style={s.previewActions}>
          {editable && state.tag === "text" && !editing && (
            <button style={button.quiet()} onClick={() => setEditing(true)}>
              Edit
            </button>
          )}
          {editing && (
            <>
              <button
                style={button.quiet()}
                onClick={() => {
                  setEditing(false);
                  setDirty(false);
                  if (state.tag === "text") setDraft(state.content);
                }}
              >
                Cancel
              </button>
              <button
                style={{ ...button.primary(size.sm), opacity: saving ? 0.6 : 1 }}
                disabled={saving || !dirty}
                onClick={() => void save()}
              >
                {saving ? "Saving…" : dirty ? "Save" : "Saved"}
              </button>
            </>
          )}
          <a href={`${fileUrl}&download=1`} style={s.downloadLink} title="Download">
            <DownloadIcon size={14} strokeWidth={2} />
          </a>
        </span>
      </div>
      <div style={s.previewBody}>{body}</div>
    </div>
  );
}

function CsvTable({ content }: { content: string }) {
  const rows = useMemo(
    () =>
      content
        .split(/\r?\n/)
        .filter((l) => l.length)
        .slice(0, 500)
        .map((line) => line.split(",")),
    [content]
  );
  if (!rows.length) return <p style={s.meta}>Empty file.</p>;
  return (
    <div style={{ overflow: "auto" }}>
      <table style={s.table}>
        <thead>
          <tr>
            {rows[0].map((cell, i) => (
              <th key={i} style={s.th}>
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(1).map((row, r) => (
            <tr key={r}>
              {row.map((cell, c) => (
                <td key={c} style={s.td}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const s: Record<string, CSSProperties> = {
  tabsBar: {
    display: "flex",
    alignItems: "stretch",
    gap: "0.25rem",
    padding: "0.4rem 0.6rem 0",
    borderBottom: "1px solid var(--rule)",
    overflowX: "auto",
    background: "var(--paper)",
  },
  tab: {
    display: "inline-flex",
    alignItems: "center",
    gap: "0.35rem",
    padding: "0.35rem 0.7rem",
    fontSize: "0.8rem",
    color: "var(--ink-muted)",
    borderBottom: "2px solid transparent",
    cursor: "pointer",
    whiteSpace: "nowrap",
    userSelect: "none",
  },
  tabActive: {
    color: "var(--ink)",
    fontWeight: 600,
    borderBottomColor: "var(--ink)",
  },
  tabLabel: { maxWidth: "160px", overflow: "hidden", textOverflow: "ellipsis" },
  tabClose: {
    display: "inline-flex",
    border: "none",
    background: "none",
    padding: "2px",
    color: "var(--ink-muted)",
    cursor: "pointer",
  },
  addTerminal: {
    alignSelf: "center",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "22px",
    height: "22px",
    marginRight: "0.35rem",
    border: "1px solid var(--rule-strong)",
    borderRadius: "var(--radius-sm)",
    background: "none",
    color: "var(--ink-muted)",
    fontSize: "0.9rem",
    lineHeight: 1,
    cursor: "pointer",
  },
  previewWrap: {
    flex: 1,
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
    background: "var(--paper)",
  },
  previewToolbar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "0.75rem",
    padding: "0.5rem 1rem",
    borderBottom: "1px solid var(--rule)",
  },
  previewPath: {
    ...type.mono,
    fontSize: "0.75rem",
    color: "var(--ink-muted)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  previewActions: { display: "inline-flex", alignItems: "center", gap: "0.75rem" },
  downloadLink: { display: "inline-flex", color: "var(--ink-muted)" },
  previewBody: { flex: 1, minHeight: 0, overflow: "auto", padding: "1.25rem 1.5rem" },
  meta: { ...type.small },
  image: { maxWidth: "100%", borderRadius: "var(--radius-sm)" },
  pdf: { width: "100%", height: "100%", minHeight: "480px", border: "none" },
  binaryCard: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: "0.9rem",
  },
  code: {
    margin: 0,
    fontFamily: "var(--font-mono)",
    fontSize: "0.8rem",
    lineHeight: 1.6,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    color: "var(--ink)",
  },
  editor: {
    width: "100%",
    height: "100%",
    minHeight: "300px",
    resize: "none",
    border: "1px solid var(--rule-strong)",
    borderRadius: "var(--radius-sm)",
    padding: "0.9rem 1rem",
    fontFamily: "var(--font-mono)",
    fontSize: "0.8rem",
    lineHeight: 1.6,
    color: "var(--ink)",
    outline: "none",
  },
  markdown: {
    fontSize: "0.925rem",
    lineHeight: 1.7,
    color: "var(--ink)",
    maxWidth: "720px",
  },
  table: { borderCollapse: "collapse", fontSize: "0.8rem" },
  th: {
    textAlign: "left",
    borderBottom: "1px solid var(--rule-strong)",
    padding: "0.35rem 0.75rem 0.35rem 0",
    fontWeight: 650,
    whiteSpace: "nowrap",
  },
  td: {
    borderBottom: "1px solid var(--rule)",
    padding: "0.3rem 0.75rem 0.3rem 0",
    whiteSpace: "nowrap",
    color: "var(--ink-soft)",
  },
};
