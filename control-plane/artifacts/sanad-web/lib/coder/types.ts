/** One item off a coder turn stream / journal (mirrors routes_coder + coder_runner). */
export type CoderItem =
  | { kind: "turn"; seq?: number; turnId: string }
  | { kind: "event"; seq?: number; event: { type?: string; payload?: Record<string, unknown> } }
  | { kind: "end"; seq?: number; status?: string }
  | { kind: "error"; seq?: number; code?: string; message?: string; turnId?: string }
  | { kind: "request"; seq?: number; requestType: "approval" | "question"; requestId: string; turnId: string; request: Record<string, unknown> }
  | { kind: "request_resolved"; seq?: number; requestId: string; requestType: "approval" | "question"; resolution: Record<string, unknown> }
  | { kind: "request_cancelled"; seq?: number; requestId: string; reason?: string };

export interface CoderTurnSummary {
  turnId: string;
  status: "running" | "finished" | "cancelled" | "failed";
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
