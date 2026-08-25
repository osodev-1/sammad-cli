/** One item off a coder turn stream / journal (mirrors routes_coder + coder_runner). */
export type CoderItem =
  | { kind: "turn"; seq?: number; turnId: string }
  | { kind: "event"; seq?: number; event: { type?: string; payload?: Record<string, unknown> } }
  | { kind: "end"; seq?: number; status?: string }
  | { kind: "error"; seq?: number; code?: string; message?: string; turnId?: string }
  | { kind: "request"; seq?: number; requestType: "approval" | "question"; requestId: string; turnId: string; request: Record<string, unknown> }
  | { kind: "request_resolved"; seq?: number; requestId: string; requestType: "approval" | "question"; resolution: Record<string, unknown> }
  | { kind: "request_cancelled"; seq?: number; requestId: string; reason?: string }
  /** A pre/post workspace snapshot (P5 Task 2, `coder_runner._checkpoint_pre`
   * / `_checkpoint_post`). `sha` is `null` when checkpointing itself failed
   * (best-effort — never blocks the turn) or, for a "post" item, when the
   * tree was unchanged since "pre" (skip-when-clean). `summary` is present
   * only on a "post" item that had both a pre and a post sha to diff. */
  | {
      kind: "checkpoint";
      seq?: number;
      when: "pre" | "post";
      sha: string | null;
      summary?: { filesChanged: number; additions: number; deletions: number };
    };

export interface CoderTurnSummary {
  turnId: string;
  /** "interrupted" is TERMINAL, not "running": a restart-recovery status
   * (P3 Task 2) the server reconciles a crash-mid-turn to on reconstruction
   * — the journal already carries a synthetic `request_cancelled` per
   * dangling request, an explanatory `error`, and a closing `end`. A caller
   * matching only `=== "running"` to decide whether to re-attach live
   * correctly leaves this status alone (see CoderPanel.begin()). */
  status: "running" | "finished" | "cancelled" | "failed" | "interrupted";
  userInput: string; // truncated to 200 chars server-side
  lastSeq: number;
  startedAt: number; // UNIX SECONDS
}

export interface PendingRequestSummary {
  requestId: string;
  requestType: "approval" | "question";
  turnId: string;
  createdAt: number;
  request: Record<string, unknown>;
}

export interface CoderTurnState {
  turn: CoderTurnSummary | null;
  alive: boolean;
  pendingRequests: PendingRequestSummary[];
  /** Live permission mode ("plan" | "default" | "accept-edits"), when the
   * server reports one. Undefined (not null) when absent — the panel treats
   * that as "default". */
  mode?: string;
  /** Server-side follow-up queue (P4b) — RAM-only, drains automatically as
   * each turn ends. Undefined (not null/[]) when the server response omits
   * it, mirroring `mode`'s pass-through convention. */
  queue?: { sendId: string; input: string }[];
}

/** One turn's checkpoint diff (P5 Task 3) — name-status + unified patch,
 * `pre..post` once the turn has finished or `pre..worktree` while it's
 * still running (server-decided; the client just renders what it gets). */
export interface CoderDiff {
  nameStatus: { status: string; path: string }[];
  patch: string;
  truncated: boolean;
  filesChanged: number;
  additions: number;
  deletions: number;
}

/** Approval payload fields the card renders (wire snake_case). */
export interface ApprovalPayload {
  id: string; tool_call_id?: string; sender?: string; action?: string;
  description?: string; source_kind?: string | null; subagent_type?: string | null;
  display?: unknown[];
}
export interface QuestionOptionPayload { label: string; description?: string }
export interface QuestionItemPayload {
  question: string; header?: string; options: QuestionOptionPayload[];
  multi_select?: boolean; body?: string; other_label?: string; other_description?: string;
}
export interface QuestionPayload { id: string; questions: QuestionItemPayload[] }

export type RespondPayload =
  | { response: "approve" | "approve_for_session" | "reject"; feedback?: string }
  | { answers: Record<string, string> };

/** `ToolCall` event payload (wire). `function.arguments` is a JSON STRING —
 * parse it with `parseToolArgs` (lib/coder/toolDisplay.ts), never JSON.parse
 * it inline (it may be null or malformed). */
export interface ToolCallPayload {
  type: "function";
  id: string;
  function: { name: string; arguments: string | null };
  extras?: Record<string, unknown>;
}

/** `ToolResult` event payload (wire). `return_value.display` is the render
 * source for a tool card — normalize it with `normalizeDisplay` before use;
 * never trust it's well-formed. */
export interface ToolResultPayload {
  tool_call_id: string;
  return_value: {
    is_error: boolean;
    output?: string;
    message?: string;
    display: DisplayBlock[];
    extras?: Record<string, unknown>;
  };
}

/** `StatusUpdate` event payload (wire) — the live mode signal (P2b Task 4
 * reads `permission_mode` off this). Other fields pass through untyped. */
export interface StatusUpdatePayload {
  permission_mode?: string | null;
  plan_mode?: boolean | null;
  [k: string]: unknown;
}

/** `PlanDisplay` event payload (wire) — emitted once, right before the
 * ExitPlanMode `QuestionRequest` that asks the user to approve/refine it.
 * `content` is the plan markdown; `file_path` is where the CLI wrote it
 * (informational — the panel never fetches it, only shows it as a caption). */
export interface PlanDisplayPayload {
  content: string;
  file_path: string;
}

/** `SteerInput` event payload (wire, P4a) — the follow-up text a mid-turn
 * steer injects into the running turn. `steerCoder` (lib/coder/client.ts)
 * posts the steer; the CLI folds it in and journals this event back onto
 * the SAME turn (no new turn started) — that's what `reduce()` renders as
 * a small "steered: <text>" marker row. */
export interface SteerInputPayload {
  user_input: string;
}

/** A shell command the tool ran (or is about to run). */
export interface ShellDisplayBlock {
  type: "shell";
  language?: string;
  command: string;
}

/** A file diff — before/after text for a hunked or full-file render. */
export interface DiffDisplayBlock {
  type: "diff";
  path: string;
  old_text: string;
  new_text: string;
  old_start?: number;
  new_start?: number;
  /** True when the tool truncated the diff (e.g. a huge file) — the card
   * should note the render is partial rather than claim completeness. */
  is_summary?: boolean;
}

export interface TodoItem {
  title: string;
  status: "pending" | "in_progress" | "done";
}

/** The agent's current plan/checklist snapshot. */
export interface TodoDisplayBlock {
  type: "todo";
  items: TodoItem[];
}

/** A pointer to a background task spawned by the tool (P7 renders the
 * drawer; P2b only carries the data through). */
export interface BackgroundTaskDisplayBlock {
  type: "background_task";
  task_id: string;
  kind?: string;
  status?: string;
  description?: string;
}

/** A short freeform note the tool attached to its result. */
export interface BriefDisplayBlock {
  type: "brief";
  text: string;
}

/** Anything the client doesn't recognize yet — passed through unrendered
 * (or rendered generically) rather than dropped, so a new server-side
 * display variant degrades gracefully instead of vanishing. */
export interface UnknownDisplayBlock {
  type: string;
  [k: string]: unknown;
}

export type DisplayBlock =
  | ShellDisplayBlock
  | DiffDisplayBlock
  | TodoDisplayBlock
  | BackgroundTaskDisplayBlock
  | BriefDisplayBlock
  | UnknownDisplayBlock;
