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
    /** Resources whose manifests an update-plan rewrites (absent pre-S9 plans). */
    nodesChanged?: string[];
    /** Resources a delete-plan removes (absent on older plans). */
    nodesRemoved?: string[];
    edgesAdded: { from: string; type: string; to: string }[];
    edgesRemoved?: { from: string; type: string; to: string }[];
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
  | { action: "createEdge"; source: string; target: string; edgeType?: string }
  | { action: "deleteResource"; id: string }
  | { action: "removeEdge"; source: string; target: string; edgeType?: string };

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

/**
 * Current on-disk content for a plan's UPDATE targets — what the review
 * modal diffs against. Bounded and best-effort: a file that cannot be read
 * (machine waking, deleted meanwhile) is simply absent, and the modal falls
 * back to full-content rendering for it.
 */
export async function fetchCurrentContents(
  plan: ChangePlan,
  sessionId?: string,
): Promise<Record<string, string>> {
  const targets = plan.operations
    .filter((o) => o.op === "update")
    .slice(0, 20)
    .map((o) => o.path);
  const out: Record<string, string> = {};
  await Promise.all(
    targets.map(async (path) => {
      try {
        const res = await fetch(
          withSession(
            `/api/workspace/file?path=${encodeURIComponent(path)}`,
            sessionId,
          ),
        );
        if (res.ok) out[path] = await res.text();
      } catch {
        /* absent → full-content fallback */
      }
    }),
  );
  return out;
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

/** Revert an applied transaction (safe: 409 stale_rollback if the tree
 * moved on since that apply — git history is the fallback then). */
export async function revertTx(
  txId: string,
  sessionId?: string,
): Promise<ApplyOutcome> {
  try {
    const res = await fetch(withSession("/api/blueprint/rollback", sessionId), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ txId }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) return { error: body?.error ?? { message: "Revert failed" } };
    return { graph: body?.data?.graph };
  } catch {
    return { error: { message: "Network error" } };
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
