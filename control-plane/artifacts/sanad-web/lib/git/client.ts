import { withSession } from "@/lib/terminal/workspace-model";

export interface GitStatus {
  isRepo: boolean;
  branch: string | null;
  head: string | null;
  ahead: number;
  behind: number;
  dirtyCount: number;
  staged: string[];
  unstaged: string[];
  untracked: string[];
}

export interface GitBranches {
  current: string | null;
  branches: string[];
}

export interface GitActionResult {
  ok: boolean;
  code?: string;
  message?: string;
}

export async function fetchGitStatus(
  sessionId?: string,
): Promise<GitStatus | null> {
  try {
    const res = await fetch(withSession("/api/git/status", sessionId));
    if (!res.ok) return null;
    return (await res.json())?.data ?? null;
  } catch {
    return null;
  }
}

export async function fetchGitBranches(
  sessionId?: string,
): Promise<GitBranches | null> {
  try {
    const res = await fetch(withSession("/api/git/branches", sessionId));
    if (!res.ok) return null;
    return (await res.json())?.data ?? null;
  } catch {
    return null;
  }
}

async function post(
  path: string,
  sessionId: string | undefined,
  body?: unknown,
): Promise<GitActionResult> {
  try {
    const res = await fetch(withSession(path, sessionId), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      return {
        ok: false,
        code: json?.error?.code,
        message: json?.error?.message,
      };
    }
    return { ok: true };
  } catch {
    return { ok: false, message: "Network error" };
  }
}

export const gitCommit = (message: string, sessionId?: string) =>
  post("/api/git/commit", sessionId, { message });
export const gitCheckout = (name: string, sessionId?: string) =>
  post("/api/git/checkout", sessionId, { name });
export const gitCreateBranch = (name: string, sessionId?: string) =>
  post("/api/git/branch", sessionId, { name });
export const gitStash = (sessionId?: string) =>
  post("/api/git/stash", sessionId);
export const gitDiscard = (sessionId?: string) =>
  post("/api/git/discard", sessionId);
