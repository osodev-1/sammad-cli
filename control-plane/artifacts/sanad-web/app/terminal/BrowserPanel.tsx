"use client";

import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { ArrowUpRightIcon, RefreshIcon } from "../ui/icons";
import { input, type } from "../ui/theme";
import { previewUrl } from "@/lib/terminal/workspace-model";

interface Props {
  /** Workspace-relative path (e.g. "site/index.html") or absolute http(s) URL. */
  url: string;
  onNavigate: (nextUrl: string) => void;
}

/**
 * The browser view: a location bar over a strictly sandboxed iframe. Workspace
 * pages are served by the sandboxed preview route (opaque origin via CSP);
 * the sandbox attribute here — deliberately WITHOUT allow-same-origin — is the
 * second, independent layer. Never weaken either.
 */
export default function BrowserPanel({ url, onNavigate }: Props) {
  const [address, setAddress] = useState(url);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    setAddress(url);
  }, [url]);

  const src = previewUrl(url);

  const commit = () => {
    const next = address.trim();
    if (next && next !== url) onNavigate(next);
    else setReloadKey((k) => k + 1);
  };

  return (
    <div style={s.wrap}>
      <div style={s.toolbar}>
        <button
          title="Refresh"
          aria-label="Refresh"
          style={s.iconButton}
          onClick={() => setReloadKey((k) => k + 1)}
        >
          <RefreshIcon size={14} strokeWidth={2} />
        </button>
        <input
          style={s.address}
          value={address}
          spellCheck={false}
          onChange={(e) => setAddress(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") setAddress(url);
          }}
          onBlur={() => setAddress(url)}
          aria-label="Preview location"
        />
        <a
          href={src}
          target="_blank"
          rel="noreferrer noopener"
          title="Open in a new tab"
          style={s.iconButton}
        >
          <ArrowUpRightIcon size={14} strokeWidth={2} />
        </a>
      </div>
      <iframe
        key={reloadKey}
        src={src}
        title={`Preview of ${url}`}
        style={s.frame}
        sandbox="allow-scripts allow-forms"
        referrerPolicy="no-referrer"
      />
    </div>
  );
}

const s: Record<string, CSSProperties> = {
  wrap: {
    flex: 1,
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
    background: "var(--paper)",
  },
  toolbar: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    padding: "0.45rem 0.75rem",
    borderBottom: "1px solid var(--rule)",
  },
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
  address: {
    ...input,
    ...type.mono,
    flex: 1,
    minWidth: 0,
    borderRadius: "var(--radius-sm)",
    padding: "0.3rem 0.7rem",
    fontSize: "0.76rem",
    color: "var(--ink-soft)",
  },
  frame: {
    flex: 1,
    minHeight: 0,
    width: "100%",
    border: "none",
    background: "#ffffff",
  },
};
