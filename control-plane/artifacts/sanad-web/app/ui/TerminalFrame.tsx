import type { CSSProperties, ReactNode } from "react";
import { surface } from "./theme";

interface Props {
  title: string;
  /** Right-aligned slot in the title bar — the live workspace puts its status here. */
  barEnd?: ReactNode;
  children: ReactNode;
  /** Merged onto the outer frame — the landing demo caps width, /terminal stretches. */
  style?: CSSProperties;
}

/**
 * The "Printed Terminal" window chrome — shared by the landing page's demo
 * card and the real workspace terminal so the two surfaces can never drift.
 */
export default function TerminalFrame({ title, barEnd, children, style }: Props) {
  return (
    <div style={{ ...s.frame, ...style }}>
      <div style={s.bar}>
        <span style={s.dot} />
        <span style={s.dot} />
        <span style={s.dot} />
        <span style={s.title}>{title}</span>
        {barEnd && <span style={s.barEnd}>{barEnd}</span>}
      </div>
      {children}
    </div>
  );
}

const s: Record<string, CSSProperties> = {
  frame: {
    ...surface.invert,
    width: "100%",
    textAlign: "left",
  },
  bar: {
    display: "flex",
    alignItems: "center",
    gap: "0.4rem",
    padding: "0.7rem 1.1rem",
    borderBottom: "1px solid rgba(255,255,255,0.14)",
  },
  dot: {
    width: "9px",
    height: "9px",
    borderRadius: "999px",
    border: "1px solid rgba(255,255,255,0.35)",
  },
  title: {
    marginLeft: "0.6rem",
    fontFamily: "var(--font-mono)",
    fontSize: "0.7rem",
    letterSpacing: "0.08em",
    color: "var(--invert-muted)",
  },
  barEnd: {
    marginLeft: "auto",
    display: "inline-flex",
    alignItems: "center",
    gap: "0.45rem",
  },
};
