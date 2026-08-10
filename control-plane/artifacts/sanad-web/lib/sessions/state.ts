import { z } from "zod";

/**
 * The restorable UI state of a PRD Session. Kept small and forgiving: it is
 * user convenience, never a source of truth. A `v` field lets the shape evolve;
 * unknown/old blobs fall back to an empty session rather than erroring.
 *
 * Aliases are display-only (TW-004): a tab alias never renames its file.
 */
export const SESSION_STATE_VERSION = 1;

export const fileTabState = z.object({
  path: z.string(),
  alias: z.string().optional(),
});

export const viewTabState = z.object({
  url: z.string(),
  alias: z.string().optional(),
});

export const terminalTabState = z.object({
  id: z.string(),
  label: z.string(),
});

/**
 * Persisted Architect transcript (S9). A RECORD of the conversation, not a
 * live draft store: text is truncated, and plan blocks keep only summary +
 * outcome — a pending plan from a dead session is stored as "expired" (its
 * preconditions are stale and the runner's context is gone), so a restored
 * card can never apply. Sizes are capped so the uiState blob stays small.
 */
export const architectBlockState = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string().max(6000) }),
  z.object({ kind: z.literal("tool"), label: z.string().max(200) }),
  z.object({
    kind: z.literal("plan"),
    summary: z.string().max(300),
    files: z.number().int().min(0).max(50),
    state: z.enum(["applied", "expired", "reverted"]),
    txId: z.string().max(80).optional(),
  }),
]);

export const architectMessageState = z.union([
  z.object({ role: z.literal("user"), text: z.string().max(8000) }),
  z.object({
    role: z.literal("assistant"),
    blocks: z.array(architectBlockState).max(80),
  }),
]);

export type StoredArchitectMessage = z.infer<typeof architectMessageState>;

export const sessionUiState = z.object({
  v: z.literal(SESSION_STATE_VERSION),
  terminals: z.array(terminalTabState).max(16).default([]),
  fileTabs: z.array(fileTabState).max(50).default([]),
  viewTabs: z.array(viewTabState).max(50).default([]),
  active: z.string().nullable().default(null),
  drawerOpen: z.boolean().default(false),
  // Graph viewport placeholder — populated when the graph tab lands (M1).
  graphViewport: z.record(z.string(), z.number()).optional(),
  // Architect chat transcript — optional so pre-S9 blobs parse unchanged.
  architect: z.array(architectMessageState).max(60).optional(),
  // Context dock visibility (R4) — optional; absent = open.
  dockOpen: z.boolean().optional(),
});

export type SessionUiState = z.infer<typeof sessionUiState>;

export const EMPTY_SESSION_STATE: SessionUiState = {
  v: SESSION_STATE_VERSION,
  terminals: [],
  fileTabs: [],
  viewTabs: [],
  active: null,
  drawerOpen: false,
};

/** Parse a stored blob, degrading anything unrecognized to an empty session. */
export function parseSessionState(raw: unknown): SessionUiState {
  const result = sessionUiState.safeParse(raw);
  return result.success ? result.data : EMPTY_SESSION_STATE;
}
