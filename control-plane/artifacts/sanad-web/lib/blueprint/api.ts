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
