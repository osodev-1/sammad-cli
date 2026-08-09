import { memo } from "react";
import type { CSSProperties } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { Severity, TrustState } from "@/lib/blueprint/types";

export interface BlueprintNodeData extends Record<string, unknown> {
  kind: string;
  name: string;
  status: "ok" | "invalid" | "unclassified";
  severity: Severity | null;
  /** S9: set when the node's executable definition is not currently trusted. */
  trust?: TrustState;
  selected?: boolean;
  focused?: boolean;
}

/** A resource node — an ordinary DOM element so it inherits the design system.
 * State is carried by border weight and a severity dot, never by hue. */
function BlueprintNodeInner({ data, selected }: NodeProps) {
  const d = data as BlueprintNodeData;
  const invalid = d.status !== "ok";
  return (
    <div
      style={{
        ...s.node,
        ...(invalid ? s.nodeInvalid : null),
        ...(selected || d.focused ? s.nodeSelected : null),
      }}
      title={`${d.kind} · ${d.name}`}
    >
      <Handle type="target" position={Position.Top} style={s.handle} />
      <span style={s.kind}>{kindLabel(d.kind)}</span>
      <span style={s.name}>{d.name}</span>
      {/* S9: unreviewed executable content is flagged in words, not hue —
          it will not load into new agent sessions until reviewed. */}
      {(d.trust === "untrusted" || d.trust === "changed") && (
        <span
          style={s.trustChip}
          title={
            d.trust === "changed"
              ? "Edited since review — re-review to activate"
              : "Not yet reviewed — review to activate"
          }
        >
          {d.trust === "changed" ? "changed" : "unreviewed"}
        </span>
      )}
      {d.severity && (
        <span
          style={{
            ...s.sev,
            ...(d.severity === "blocking" ? s.sevBlocking : s.sevWarn),
          }}
          title={d.severity}
        />
      )}
      <Handle type="source" position={Position.Bottom} style={s.handle} />
    </div>
  );
}

export const BlueprintNode = memo(BlueprintNodeInner);

function kindLabel(kind: string): string {
  if (kind === "UnclassifiedFile") return "file";
  return kind.toLowerCase();
}

const s: Record<string, CSSProperties> = {
  node: {
    position: "relative",
    width: 190,
    minHeight: 46,
    boxSizing: "border-box",
    display: "flex",
    flexDirection: "column",
    justifyContent: "center",
    gap: "2px",
    padding: "0.4rem 0.7rem",
    background: "var(--paper)",
    border: "1px solid var(--rule-strong)",
    borderRadius: "var(--radius-md)",
    boxShadow: "var(--shadow-soft)",
    cursor: "pointer",
  },
  nodeInvalid: { borderStyle: "dashed" },
  nodeSelected: { borderColor: "var(--ink)", borderWidth: "1.5px" },
  kind: {
    fontFamily: "var(--font-mono)",
    fontSize: "0.6rem",
    letterSpacing: "0.1em",
    textTransform: "uppercase",
    color: "var(--ink-muted)",
  },
  name: {
    fontSize: "0.82rem",
    fontWeight: 600,
    color: "var(--ink)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  sev: {
    position: "absolute",
    top: "6px",
    right: "6px",
    width: "7px",
    height: "7px",
    borderRadius: "999px",
  },
  sevBlocking: { background: "var(--ink)" },
  sevWarn: { background: "var(--ink)", opacity: 0.4 },
  /* Words over hue: hatched border + mono label survive greyscale. */
  trustChip: {
    alignSelf: "flex-start",
    marginTop: "2px",
    fontFamily: "var(--font-mono)",
    fontSize: "0.56rem",
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    color: "var(--ink)",
    border: "1px dashed var(--ink)",
    borderRadius: "var(--radius-pill)",
    padding: "0 0.35rem",
    lineHeight: 1.6,
  },
  handle: {
    width: "6px",
    height: "6px",
    background: "var(--rule-strong)",
    border: "none",
  },
};
