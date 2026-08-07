import type { CSSProperties } from "react";
import type { BlueprintGraph, BlueprintNode } from "@/lib/blueprint/types";

/** Read-only resource inspector (M1). Selecting a node reveals its files,
 * relationships, and diagnostics; "Open" reveals the manifest in the editor. */
export default function Inspector({
  node,
  graph,
  onOpenFile,
  onClose,
}: {
  node: BlueprintNode;
  graph: BlueprintGraph;
  onOpenFile: (path: string) => void;
  onClose: () => void;
}) {
  const diagnostics = graph.diagnostics.filter(
    (d) => d.resource_id === node.id,
  );
  const outbound = graph.edges.filter((e) => e.source === node.id);
  const inbound = graph.edges.filter((e) => e.target === node.id);

  return (
    <aside style={s.pane}>
      <div style={s.header}>
        <div style={s.headerText}>
          <span style={s.kind}>{node.kind}</span>
          <span style={s.name}>{node.name}</span>
        </div>
        <button style={s.close} onClick={onClose} aria-label="Close inspector">
          ×
        </button>
      </div>

      <div style={s.body}>
        <Section title="Files">
          <button style={s.fileLink} onClick={() => onOpenFile(node.path)}>
            {node.path}
          </button>
          {node.supporting_paths.map((p) => (
            <button key={p} style={s.fileLink} onClick={() => onOpenFile(p)}>
              {p}
            </button>
          ))}
        </Section>

        {outbound.length > 0 && (
          <Section title="Depends on">
            {outbound.map((e) => (
              <div key={e.id} style={s.rel}>
                <span style={s.relType}>{e.type}</span>
                <span style={e.broken ? s.relBroken : s.relTarget}>
                  {e.target}
                </span>
              </div>
            ))}
          </Section>
        )}

        {inbound.length > 0 && (
          <Section title="Used by">
            {inbound.map((e) => (
              <div key={e.id} style={s.rel}>
                <span style={s.relTarget}>{e.source}</span>
                <span style={s.relType}>{e.type}</span>
              </div>
            ))}
          </Section>
        )}

        {diagnostics.length > 0 && (
          <Section title="Diagnostics">
            {diagnostics.map((d, i) => (
              <div key={i} style={s.diag}>
                <span
                  style={{
                    ...s.diagDot,
                    ...(d.severity === "blocking"
                      ? s.diagBlocking
                      : s.diagWarn),
                  }}
                />
                <span style={s.diagMsg}>{d.message}</span>
              </div>
            ))}
          </Section>
        )}
      </div>
    </aside>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div style={s.section}>
      <span style={s.sectionTitle}>{title}</span>
      {children}
    </div>
  );
}

const s: Record<string, CSSProperties> = {
  pane: {
    width: "260px",
    minWidth: "260px",
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
    borderLeft: "1px solid var(--rule)",
    background: "var(--paper)",
  },
  header: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: "0.5rem",
    padding: "0.7rem 0.85rem",
    borderBottom: "1px solid var(--rule)",
  },
  headerText: {
    display: "flex",
    flexDirection: "column",
    gap: "2px",
    minWidth: 0,
  },
  kind: {
    fontFamily: "var(--font-mono)",
    fontSize: "0.62rem",
    letterSpacing: "0.1em",
    textTransform: "uppercase",
    color: "var(--ink-muted)",
  },
  name: { fontSize: "0.95rem", fontWeight: 650, color: "var(--ink)" },
  close: {
    background: "none",
    border: "none",
    fontSize: "1.1rem",
    lineHeight: 1,
    color: "var(--ink-muted)",
    cursor: "pointer",
    padding: "0 0.2rem",
  },
  body: {
    flex: 1,
    minHeight: 0,
    overflowY: "auto",
    padding: "0.5rem 0.85rem 1rem",
  },
  section: {
    display: "flex",
    flexDirection: "column",
    gap: "0.35rem",
    marginTop: "1rem",
  },
  sectionTitle: {
    fontFamily: "var(--font-mono)",
    fontSize: "0.62rem",
    letterSpacing: "0.1em",
    textTransform: "uppercase",
    color: "var(--ink-muted)",
  },
  fileLink: {
    textAlign: "left",
    background: "none",
    border: "none",
    padding: "0.15rem 0",
    fontFamily: "var(--font-mono)",
    fontSize: "0.75rem",
    color: "var(--ink-soft)",
    cursor: "pointer",
    textDecoration: "underline",
    textUnderlineOffset: "2px",
    textDecorationColor: "var(--rule-strong)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  rel: {
    display: "flex",
    alignItems: "center",
    gap: "0.4rem",
    fontSize: "0.78rem",
  },
  relType: {
    fontFamily: "var(--font-mono)",
    fontSize: "0.68rem",
    color: "var(--ink-muted)",
  },
  relTarget: {
    color: "var(--ink-soft)",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  relBroken: {
    color: "var(--ink)",
    textDecoration: "line-through",
    textDecorationStyle: "wavy",
  },
  diag: {
    display: "flex",
    gap: "0.45rem",
    alignItems: "flex-start",
    fontSize: "0.78rem",
  },
  diagDot: {
    marginTop: "5px",
    width: "6px",
    height: "6px",
    flexShrink: 0,
    borderRadius: "999px",
  },
  diagBlocking: { background: "var(--ink)" },
  diagWarn: { background: "var(--ink)", opacity: 0.4 },
  diagMsg: { color: "var(--ink-soft)", lineHeight: 1.4 },
};
