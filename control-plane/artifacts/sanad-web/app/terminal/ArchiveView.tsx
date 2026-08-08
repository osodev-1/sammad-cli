"use client";

import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { formatBytes, withSession } from "@/lib/terminal/workspace-model";

interface ArchiveEntry {
  name: string;
  size: number;
  isDir: boolean;
}

type State =
  | { tag: "loading" }
  | { tag: "error"; message: string }
  | { tag: "ok"; entries: ArchiveEntry[]; truncated: boolean };

/**
 * Read-only archive listing (S7). Shows a zip/tar's members and sizes without
 * extracting — agentd lists them in-process; nothing is written or run.
 */
export default function ArchiveView({
  path,
  sessionId,
}: {
  path: string;
  sessionId?: string;
}) {
  const [state, setState] = useState<State>({ tag: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ tag: "loading" });
    (async () => {
      const res = await fetch(
        withSession(
          `/api/workspace/archive-list?path=${encodeURIComponent(path)}`,
          sessionId,
        ),
      );
      if (cancelled) return;
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setState({
          tag: "error",
          message: body?.error?.message ?? "Could not read this archive.",
        });
        return;
      }
      const data = body?.data;
      setState({
        tag: "ok",
        entries: data?.entries ?? [],
        truncated: !!data?.truncated,
      });
    })().catch(() => {
      if (!cancelled)
        setState({ tag: "error", message: "Could not read this archive." });
    });
    return () => {
      cancelled = true;
    };
  }, [path, sessionId]);

  if (state.tag === "loading") return <p style={s.meta}>Reading archive…</p>;
  if (state.tag === "error") return <p style={s.meta}>{state.message}</p>;

  const files = state.entries.filter((e) => !e.isDir);
  const totalBytes = files.reduce((n, e) => n + e.size, 0);

  return (
    <div style={s.wrap}>
      <div style={s.summary}>
        {files.length} file{files.length === 1 ? "" : "s"} ·{" "}
        {formatBytes(totalBytes)}
        {state.truncated && " · first 2000 entries"}
      </div>
      <div style={s.list}>
        {state.entries.map((e, i) => (
          <div key={i} style={s.row}>
            <span style={{ ...s.name, ...(e.isDir ? s.dir : null) }}>
              {e.isDir ? `${e.name.replace(/\/$/, "")}/` : e.name}
            </span>
            <span style={s.size}>{e.isDir ? "" : formatBytes(e.size)}</span>
          </div>
        ))}
        {state.entries.length === 0 && (
          <div style={s.meta}>This archive is empty.</div>
        )}
      </div>
    </div>
  );
}

const s: Record<string, CSSProperties> = {
  wrap: { flex: 1, minHeight: 0, display: "flex", flexDirection: "column" },
  meta: { padding: "1.25rem", color: "var(--ink-muted)", fontSize: "0.85rem" },
  summary: {
    padding: "0.6rem 0.9rem",
    borderBottom: "1px solid var(--rule)",
    fontFamily: "var(--font-mono)",
    fontSize: "0.72rem",
    letterSpacing: "0.04em",
    color: "var(--ink-muted)",
  },
  list: { flex: 1, minHeight: 0, overflowY: "auto", padding: "0.35rem 0" },
  row: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: "1rem",
    padding: "0.22rem 0.9rem",
    fontFamily: "var(--font-mono)",
    fontSize: "0.78rem",
  },
  name: { color: "var(--ink)", overflowWrap: "anywhere", minWidth: 0 },
  dir: { color: "var(--ink-muted)" },
  size: {
    color: "var(--ink-muted)",
    flexShrink: 0,
    fontVariantNumeric: "tabular-nums",
  },
};
