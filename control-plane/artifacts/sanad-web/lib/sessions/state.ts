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

export const sessionUiState = z.object({
  v: z.literal(SESSION_STATE_VERSION),
  terminals: z.array(terminalTabState).max(16).default([]),
  fileTabs: z.array(fileTabState).max(50).default([]),
  viewTabs: z.array(viewTabState).max(50).default([]),
  active: z.string().nullable().default(null),
  drawerOpen: z.boolean().default(false),
  // Graph viewport placeholder — populated when the graph tab lands (M1).
  graphViewport: z.record(z.string(), z.number()).optional(),
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
