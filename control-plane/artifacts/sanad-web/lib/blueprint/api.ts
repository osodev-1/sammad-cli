import { withSession } from "@/lib/terminal/workspace-model";
import type { BlueprintGraph } from "./types";

/** Fetch the compiled blueprint graph for a project session. */
export async function fetchBlueprintGraph(
  sessionId?: string,
): Promise<BlueprintGraph | null> {
  try {
    const res = await fetch(withSession("/api/blueprint/graph", sessionId));
    if (!res.ok) return null;
    const body = await res.json();
    const data = body?.data as BlueprintGraph | undefined;
    if (!data || !Array.isArray(data.nodes)) return null;
    return data;
  } catch {
    return null;
  }
}

export interface ChangePlan {
  summary: string;
  operations: { op: string; path: string; content?: string | null }[];
  preconditions: { path: string; sha256: string | null }[];
  graphDelta: {
    nodesAdded: string[];
    edgesAdded: { from: string; type: string; to: string }[];
  };
}

export interface CreatableKind {
  kind: string;
  prefix: string;
}

export async function fetchCreatableKinds(
  sessionId?: string,
): Promise<CreatableKind[]> {
  try {
    const res = await fetch(withSession("/api/blueprint/templates", sessionId));
    if (!res.ok) return [];
    return (await res.json())?.data?.kinds ?? [];
  } catch {
    return [];
  }
}

type PlanRequest =
  | { action: "createResource"; kind: string; name: string }
  | { action: "createEdge"; source: string; target: string; edgeType?: string };

export interface PlanOutcome {
  plan?: ChangePlan;
  error?: { code?: string; message?: string };
}

/** Build a change plan (dry — nothing is written until apply). */
export async function draftPlan(
  req: PlanRequest,
  sessionId?: string,
): Promise<PlanOutcome> {
  try {
    const res = await fetch(withSession("/api/blueprint/plan", sessionId), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok)
      return { error: body?.error ?? { message: "Could not build the plan" } };
    return { plan: body?.data?.plan };
  } catch {
    return { error: { message: "Network error" } };
  }
}

export interface ApplyOutcome {
  graph?: BlueprintGraph;
  txId?: string;
  error?: { code?: string; message?: string };
}

/**
 * S9 manual trust review: approve an executable definition at its current
 * content so new agent sessions load it. Returns ok or an error message.
 */
export async function reviewTrust(
  path: string,
  sessionId?: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(withSession("/api/blueprint/trust", sessionId), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      return {
        ok: false,
        error: body?.error?.message ?? "Could not record the review",
      };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: "Network error" };
  }
}

/** Apply an approved plan; returns the fresh graph. */
export async function applyPlan(
  plan: ChangePlan,
  sessionId?: string,
): Promise<ApplyOutcome> {
  try {
    const res = await fetch(withSession("/api/blueprint/apply", sessionId), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ plan }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) return { error: body?.error ?? { message: "Apply failed" } };
    return { graph: body?.data?.graph, txId: body?.data?.txId };
  } catch {
    return { error: { message: "Network error" } };
  }
}
