"use client";

import type { CSSProperties } from "react";
import type { TerminalPhase } from "./TerminalPanel";
import type { ThemeMode } from "@/lib/terminal/xtermTheme";

/** Quiet bottom strip: connection state + the light/dark switch. */
export default function StatusBar({
  phase,
  themeMode,
  onToggleTheme,
}: {
  phase: TerminalPhase;
  themeMode: ThemeMode;
  onToggleTheme: () => void;
}) {
  const label =
    phase.tag === "live"
      ? "live"
      : phase.tag === "connecting"
        ? "connecting"
        : "offline";
  return (
    <div style={s.wrap}>
      <span style={s.left}>Your workspace</span>
      <span style={s.right}>
        <button
          type="button"
          style={s.themeButton}
          onClick={onToggleTheme}
          title={themeMode === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          aria-label={themeMode === "dark" ? "Switch to light mode" : "Switch to dark mode"}
        >
          {themeMode === "dark" ? "light" : "dark"}
        </button>
        <span
          style={{ ...s.dot, ...(phase.tag === "live" ? s.dotLive : null) }}
        />
        {label}
      </span>
    </div>
  );
}

const s: Record<string, CSSProperties> = {
  wrap: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "0.35rem 1rem",
    borderTop: "1px solid var(--rule)",
    background: "var(--paper)",
    fontFamily: "var(--font-mono)",
    fontSize: "0.68rem",
    letterSpacing: "0.08em",
    color: "var(--ink-muted)",
  },
  left: {},
  right: { display: "inline-flex", alignItems: "center", gap: "0.45rem" },
  themeButton: {
    font: "inherit",
    letterSpacing: "inherit",
    color: "var(--ink-muted)",
    background: "none",
    border: "1px solid var(--rule-strong)",
    borderRadius: "var(--radius-pill)",
    padding: "0.1rem 0.55rem",
    cursor: "pointer",
    marginRight: "0.55rem",
  },
  dot: {
    width: "7px",
    height: "7px",
    borderRadius: "999px",
    border: "1px solid var(--ink-muted)",
  },
  dotLive: { background: "var(--ink)", borderColor: "var(--ink)" },
};
