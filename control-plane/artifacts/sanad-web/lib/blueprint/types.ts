/**
 * The browser's stable contract with the blueprint kernel: the graph payload,
 * not the manifests. Kind specs can evolve without breaking this shape (the
 * kernel exports JSON Schema separately for forms). Mirrors
 * sanad_blueprint.graph.{Node,Edge} and diagnostics.Diagnostic.
 */

export type Severity = "blocking" | "warning" | "info";

export interface Diagnostic {
  severity: Severity;
  code: string;
  message: string;
  resource_id: string | null;
  path: string | null;
}

/** S9 trust state of a node's executable definition (e.g. a skill's SKILL.md). */
export type TrustState = "trusted" | "untrusted" | "changed";

export interface BlueprintNode {
  id: string;
  kind: string; // ResourceKind value or "UnclassifiedFile"
  name: string;
  path: string;
  status: "ok" | "invalid" | "unclassified";
  supporting_paths: string[];
  /**
   * Present only when the node has a gated executable definition. "untrusted"
   * and "changed" content is excluded from new agent sessions until reviewed.
   */
  trust?: TrustState;
}

export interface BlueprintEdge {
  id: string;
  source: string;
  target: string;
  type: string;
  broken: boolean;
  permission_expanding: boolean;
}

export interface BlueprintGraph {
  nodes: BlueprintNode[];
  edges: BlueprintEdge[];
  diagnostics: Diagnostic[];
  initialized: boolean;
}

/** Worst diagnostic severity for a resource, or null if clean. */
export function worstSeverity(
  diagnostics: Diagnostic[],
  resourceId: string,
): Severity | null {
  let worst: Severity | null = null;
  const rank: Record<Severity, number> = { info: 1, warning: 2, blocking: 3 };
  for (const d of diagnostics) {
    if (d.resource_id !== resourceId) continue;
    if (worst === null || rank[d.severity] > rank[worst]) worst = d.severity;
  }
  return worst;
}
