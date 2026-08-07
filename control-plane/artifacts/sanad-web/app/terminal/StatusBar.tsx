"use client";

import type { CSSProperties } from "react";
import type { TerminalPhase } from "./TerminalPanel";

/** Quiet bottom strip: connection state only — never infrastructure words. */
export default function StatusBar({ phase }: { phase: TerminalPhase }) {
  const label =
    phase.tag === "live"
      ? "live"
      : phase.tag === "connecting" || phase.tag === "reconnecting"
        ? "connecting"
        : "offline";
  return (
    <div style={s.wrap}>
      <span style={s.left}>Your workspace</span>
      <span style={s.right}>
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
  dot: {
    width: "7px",
    height: "7px",
    borderRadius: "999px",
    border: "1px solid var(--ink-muted)",
  },
  dotLive: { background: "var(--ink)", borderColor: "var(--ink)" },
};
