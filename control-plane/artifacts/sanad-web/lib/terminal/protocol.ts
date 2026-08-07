/**
 * Wire protocol for the browser workspace <-> terminal-service WebSocket.
 *
 * Binary frames are raw PTY bytes in both directions; text frames are single
 * JSON control objects. Kept in lockstep with the Python side
 * (terminal-server/src/sanad_terminal/protocol.py). Pure and DOM-free so the
 * framing is unit-testable in the node vitest environment.
 */

export type ClientControl =
  | { type: "auth"; ticket: string; cols?: number; rows?: number; mode?: "agent" | "shell" | "events" }
  | { type: "resize"; cols: number; rows: number }
  | { type: "ping" };

export type ServerControl =
  | { type: "ready"; userId: string; cols: number; rows: number }
  | { type: "pong" }
  | { type: "warning"; reason: string; secondsLeft: number }
  | { type: "exit"; code: number | null }
  | { type: "event"; channel: string; version: number }
  | { type: "error"; code: string; message?: string };

export const encodeControl = (msg: ClientControl): string => JSON.stringify(msg);

/** Tolerant parse — unknown or malformed control frames return null (ignored). */
export function parseServerControl(raw: string): ServerControl | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null) return null;
  const m = v as Record<string, unknown>;
  switch (m.type) {
    case "ready":
      if (typeof m.userId !== "string") return null;
      return {
        type: "ready",
        userId: m.userId,
        cols: typeof m.cols === "number" ? m.cols : 80,
        rows: typeof m.rows === "number" ? m.rows : 24,
      };
    case "pong":
      return { type: "pong" };
    case "warning":
      return {
        type: "warning",
        reason: typeof m.reason === "string" ? m.reason : "unknown",
        secondsLeft: typeof m.secondsLeft === "number" ? m.secondsLeft : 0,
      };
    case "exit":
      return { type: "exit", code: typeof m.code === "number" ? m.code : null };
    case "event":
      if (typeof m.channel !== "string" || typeof m.version !== "number") return null;
      return { type: "event", channel: m.channel, version: m.version };
    case "error":
      if (typeof m.code !== "string") return null;
      return {
        type: "error",
        code: m.code,
        message: typeof m.message === "string" ? m.message : undefined,
      };
    default:
      return null;
  }
}

/** Session-POST error codes that render as product panels, not raw errors. */
export type BlockedCode = "terminal_not_enabled" | "no_plan" | "no_seat";
export const isBlockedCode = (c: unknown): c is BlockedCode =>
  c === "terminal_not_enabled" || c === "no_plan" || c === "no_seat";

/**
 * The one seam for concurrency semantics. v1 servers evict the older
 * connection (`session_replaced`); a future refuse-mode collapses into the
 * same conflict condition with different copy.
 */
export type ConflictKind = "taken_over" | "refused" | null;
export function classifyConflict(code: string): ConflictKind {
  if (code === "session_replaced") return "taken_over";
  if (code === "session_exists") return "refused";
  return null;
}

export interface SessionGrant {
  ticket: string;
  wsUrl: string;
}

/** Parse the POST /api/terminal/session success envelope. */
export function parseSessionGrant(body: unknown): SessionGrant | null {
  const d = (body as { data?: Record<string, unknown> } | null)?.data;
  if (!d || typeof d.ticket !== "string" || typeof d.wsUrl !== "string") return null;
  return { ticket: d.ticket, wsUrl: d.wsUrl };
}
