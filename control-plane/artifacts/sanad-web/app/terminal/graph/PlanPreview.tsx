import type { CSSProperties } from "react";
import type { ChangePlan } from "@/lib/blueprint/api";

/**
 * The change-plan review card (PRD MA-005 / GR-007): every write is previewed
 * as the exact files it creates or patches before the user applies it.
 */
export default function PlanPreview({
  plan,
  busy,
  error,
  onApply,
  onCancel,
}: {
  plan: ChangePlan;
  busy: boolean;
  error: string | null;
  onApply: () => void;
  onCancel: () => void;
}) {
  return (
    <div style={s.overlay} onClick={onCancel}>
      <div style={s.card} onClick={(e) => e.stopPropagation()}>
        <div style={s.header}>
          <span style={s.eyebrow}>Review change</span>
          <span style={s.summary}>{plan.summary}</span>
        </div>

        <div style={s.body}>
          {plan.operations.map((op) => (
            <div key={op.path} style={s.op}>
              <div style={s.opHead}>
                <span style={s.opBadge}>{op.op}</span>
                <span style={s.opPath}>{op.path}</span>
              </div>
              {op.content != null && <pre style={s.content}>{op.content}</pre>}
            </div>
          ))}
          {plan.graphDelta.edgesAdded.length > 0 && (
            <div style={s.op}>
              <span style={s.opBadge}>edge</span>
              {plan.graphDelta.edgesAdded.map((e, i) => (
                <span key={i} style={s.edge}>
                  {e.from} <span style={s.edgeType}>{e.type}</span> {e.to}
                </span>
              ))}
            </div>
          )}
        </div>

        {error && <div style={s.error}>{error}</div>}

        <div style={s.footer}>
          <button style={s.cancel} onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button style={s.apply} onClick={onApply} disabled={busy}>
            {busy ? "Applying…" : "Apply"}
          </button>
        </div>
      </div>
    </div>
  );
}

const s: Record<string, CSSProperties> = {
  overlay: {
    position: "absolute",
    inset: 0,
    zIndex: 100,
    background: "rgba(10,10,10,0.28)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "1.5rem",
  },
  card: {
    width: "min(560px, 100%)",
    maxHeight: "100%",
    display: "flex",
    flexDirection: "column",
    background: "var(--paper)",
    border: "1px solid var(--rule-strong)",
    borderRadius: "var(--radius-lg)",
    boxShadow: "var(--shadow-soft)",
    overflow: "hidden",
  },
  header: {
    display: "flex",
    flexDirection: "column",
    gap: "0.25rem",
    padding: "1rem 1.25rem 0.75rem",
    borderBottom: "1px solid var(--rule)",
  },
  eyebrow: {
    fontFamily: "var(--font-mono)",
    fontSize: "0.62rem",
    letterSpacing: "0.12em",
    textTransform: "uppercase",
    color: "var(--ink-muted)",
  },
  summary: { fontSize: "0.98rem", fontWeight: 650, color: "var(--ink)" },
  body: {
    overflowY: "auto",
    padding: "0.85rem 1.25rem",
    display: "flex",
    flexDirection: "column",
    gap: "0.85rem",
  },
  op: { display: "flex", flexDirection: "column", gap: "0.35rem" },
  opHead: { display: "flex", alignItems: "center", gap: "0.5rem" },
  opBadge: {
    fontFamily: "var(--font-mono)",
    fontSize: "0.6rem",
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    color: "var(--ink)",
    border: "1px solid var(--rule-strong)",
    borderRadius: "var(--radius-pill)",
    padding: "0.05rem 0.5rem",
  },
  opPath: {
    fontFamily: "var(--font-mono)",
    fontSize: "0.76rem",
    color: "var(--ink-soft)",
  },
  content: {
    margin: 0,
    padding: "0.6rem 0.75rem",
    background: "var(--paper-sunken)",
    border: "1px solid var(--rule)",
    borderRadius: "var(--radius-sm)",
    fontFamily: "var(--font-mono)",
    fontSize: "0.72rem",
    lineHeight: 1.5,
    color: "var(--ink)",
    whiteSpace: "pre-wrap",
    overflowX: "auto",
    maxHeight: "220px",
  },
  edge: {
    fontFamily: "var(--font-mono)",
    fontSize: "0.78rem",
    color: "var(--ink-soft)",
  },
  edgeType: { color: "var(--ink-muted)" },
  error: {
    padding: "0.6rem 1.25rem",
    fontSize: "0.8rem",
    color: "var(--ink)",
    borderTop: "1px solid var(--rule)",
  },
  footer: {
    display: "flex",
    justifyContent: "flex-end",
    gap: "0.6rem",
    padding: "0.75rem 1.25rem",
    borderTop: "1px solid var(--rule)",
  },
  cancel: {
    background: "none",
    border: "none",
    color: "var(--ink-muted)",
    fontSize: "0.85rem",
    cursor: "pointer",
    padding: "0.3rem 0.6rem",
  },
  apply: {
    background: "var(--ink)",
    color: "var(--paper)",
    border: "none",
    borderRadius: "var(--radius-pill)",
    fontSize: "0.85rem",
    fontWeight: 600,
    padding: "0.4rem 1.2rem",
    cursor: "pointer",
  },
};
