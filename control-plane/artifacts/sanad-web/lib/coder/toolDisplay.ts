import { TOOL_LABELS } from "./client";
import type {
  BackgroundTaskDisplayBlock,
  DiffDisplayBlock,
  DisplayBlock,
  ShellDisplayBlock,
  TodoDisplayBlock,
  TodoItem,
} from "./types";

/**
 * Pure, throw-never parsers that turn the raw ToolCall/ToolResult wire
 * payloads into typed, display-ready shapes. Nothing here talks to the
 * network or the journal — lib/coder/transcript.ts `reduce()` is the only
 * caller.
 */

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** `ToolCall.function.arguments` is a JSON STRING on the wire (and may be
 * null, or malformed if the model emitted garbage) — this never throws. */
export function parseToolArgs(
  _name: string,
  argumentsJson: string | null | undefined,
): Record<string, unknown> {
  if (!argumentsJson) return {};
  try {
    const parsed: unknown = JSON.parse(argumentsJson);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

/** A concrete, present-tense label for a tool call, using its args when
 * available (falls back to the generic per-tool phrase, then a bare
 * "Running <name>"). Replaces the old arg-less `toolLabel` for the live
 * transcript model — `toolLabel` (lib/coder/client.ts) stays for the
 * activity line, which has no args to work with. */
export function toolActionLabel(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "Shell": {
      const command = str(args.command);
      if (command) return `Run \`${clip(command, 80)}\``;
      break;
    }
    case "WriteFile":
    case "StrReplaceFile": {
      const path = str(args.path);
      if (path) return `Edit ${path}`;
      break;
    }
    case "ReadFile": {
      const path = str(args.path);
      if (path) return `Read ${path}`;
      break;
    }
    case "Grep": {
      const pattern = str(args.pattern);
      if (pattern) return `Grep \`${clip(pattern, 80)}\``;
      break;
    }
    case "Glob": {
      const pattern = str(args.pattern);
      if (pattern) return `Find \`${clip(pattern, 80)}\``;
      break;
    }
    default:
      break;
  }
  return TOOL_LABELS[name] ?? (name ? `Running ${name}` : "Working");
}

function normalizeShell(r: Record<string, unknown>): ShellDisplayBlock | null {
  if (typeof r.command !== "string") return null;
  return {
    type: "shell",
    command: r.command,
    ...(typeof r.language === "string" ? { language: r.language } : {}),
  };
}

function normalizeDiff(r: Record<string, unknown>): DiffDisplayBlock | null {
  if (typeof r.path !== "string") return null;
  if (typeof r.old_text !== "string" || typeof r.new_text !== "string") return null;
  return {
    type: "diff",
    path: r.path,
    old_text: r.old_text,
    new_text: r.new_text,
    ...(typeof r.old_start === "number" ? { old_start: r.old_start } : {}),
    ...(typeof r.new_start === "number" ? { new_start: r.new_start } : {}),
    ...(typeof r.is_summary === "boolean" ? { is_summary: r.is_summary } : {}),
  };
}

function normalizeTodoItem(raw: unknown): TodoItem | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.title !== "string") return null;
  if (r.status !== "pending" && r.status !== "in_progress" && r.status !== "done") return null;
  return { title: r.title, status: r.status };
}

function normalizeTodo(r: Record<string, unknown>): TodoDisplayBlock | null {
  if (!Array.isArray(r.items)) return null;
  const items = r.items
    .map(normalizeTodoItem)
    .filter((item): item is TodoItem => item !== null);
  return { type: "todo", items };
}

function normalizeBackgroundTask(r: Record<string, unknown>): BackgroundTaskDisplayBlock | null {
  if (typeof r.task_id !== "string") return null;
  return {
    type: "background_task",
    task_id: r.task_id,
    ...(typeof r.kind === "string" ? { kind: r.kind } : {}),
    ...(typeof r.status === "string" ? { status: r.status } : {}),
    ...(typeof r.description === "string" ? { description: r.description } : {}),
  };
}

function normalizeOne(raw: unknown): DisplayBlock | null {
  if (!raw || typeof raw !== "object") return null;
  const type = (raw as { type?: unknown }).type;
  if (typeof type !== "string") return null;
  const r = raw as Record<string, unknown>;
  switch (type) {
    case "shell":
      return normalizeShell(r);
    case "diff":
      return normalizeDiff(r);
    case "todo":
      return normalizeTodo(r);
    case "background_task":
      return normalizeBackgroundTask(r);
    case "brief":
      return typeof r.text === "string" ? { type: "brief", text: r.text } : null;
    default:
      // Forward-compatible fallback: an unrecognized-but-well-formed `type`
      // passes through unrendered rather than getting dropped, so a new
      // server-side display variant degrades gracefully.
      return r as DisplayBlock;
  }
}

/** Validate/coerce a raw `ToolResult.return_value.display` array into typed
 * `DisplayBlock[]`, dropping malformed entries. Never throws — a bad or
 * missing display array degrades to `[]`, and the card falls back to the
 * tool's label. */
export function normalizeDisplay(blocks: unknown): DisplayBlock[] {
  if (!Array.isArray(blocks)) return [];
  const out: DisplayBlock[] = [];
  for (const raw of blocks) {
    const block = normalizeOne(raw);
    if (block) out.push(block);
  }
  return out;
}
