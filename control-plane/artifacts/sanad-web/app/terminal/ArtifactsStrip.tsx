"use client";

import { withSession } from "@/lib/terminal/workspace-model";
import type { CSSProperties } from "react";
import { DownloadIcon } from "../ui/icons";
import { button, type } from "../ui/theme";
import { formatBytes, type WsEntry } from "@/lib/terminal/workspace-model";

/**
 * Agent outputs as first-class artifacts: anything created or changed during
 * this session surfaces here with Open/Download — never a path to copy out of
 * the terminal.
 */
export default function ArtifactsStrip({
  artifacts,
  onOpen,
  sessionId,
}: {
  artifacts: WsEntry[];
  onOpen: (path: string) => void;
  sessionId?: string;
}) {
  if (!artifacts.length) return null;
  return (
    <div style={s.wrap}>
      <span style={s.title}>New this session</span>
      <div style={s.cards}>
        {artifacts.map((a) => (
          <div key={a.path} style={s.card}>
            <span style={s.name} title={a.path}>
              {a.name}
            </span>
            <span style={s.meta}>{formatBytes(a.size)}</span>
            <span style={s.actions}>
              <button style={button.quiet()} onClick={() => onOpen(a.path)}>
                Open
              </button>
              <a
                href={withSession(`/api/workspace/file?path=${encodeURIComponent(a.path)}&download=1`, sessionId)}
                style={s.download}
                title="Download"
              >
                <DownloadIcon size={13} strokeWidth={2} />
              </a>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

const s: Record<string, CSSProperties> = {
  wrap: {
    display: "flex",
    alignItems: "center",
    gap: "1rem",
    padding: "0.5rem 1rem",
    borderTop: "1px solid var(--rule)",
    background: "var(--paper)",
    overflowX: "auto",
  },
  title: { ...type.eyebrow, whiteSpace: "nowrap" },
  cards: { display: "flex", gap: "0.6rem" },
  card: {
    display: "inline-flex",
    alignItems: "center",
    gap: "0.55rem",
    border: "1px solid var(--rule-strong)",
    borderRadius: "var(--radius-pill)",
    padding: "0.25rem 0.4rem 0.25rem 0.8rem",
    whiteSpace: "nowrap",
  },
  name: {
    fontFamily: "var(--font-mono)",
    fontSize: "0.75rem",
    color: "var(--ink)",
    maxWidth: "180px",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  meta: { ...type.small, fontSize: "0.68rem" },
  actions: { display: "inline-flex", alignItems: "center", gap: "0.45rem" },
  download: { display: "inline-flex", color: "var(--ink-muted)" },
};
