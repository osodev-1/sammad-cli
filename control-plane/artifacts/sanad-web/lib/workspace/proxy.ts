/**
 * Workspace proxy: same-origin browser calls forwarded to the terminal
 * service's internal REST with the shared service secret.
 *
 * The browser never talks to the terminal service directly (its REST surface
 * requires the secret; CORS stays closed). Ownership is derived here from the
 * Clerk session — the client can never name another user's workspace.
 */
import { auth, currentUser } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { err } from "../http/envelope";
import { isTerminalAllowed } from "../auth/terminal";
import { isCoderPanelAllowed } from "../auth/coder";

export type WorkspaceAuth = { ok: true; userId: string } | { ok: false; response: NextResponse };

/** Clerk + allowlist gate shared by every /api/workspace/* route. */
export async function authenticateWorkspace(): Promise<WorkspaceAuth> {
  const { userId } = await auth();
  if (!userId) {
    return { ok: false, response: err(401, "unauthorized", "Must be signed in") };
  }
  const clerkUser = await currentUser();
  const email = clerkUser?.emailAddresses[0]?.emailAddress ?? "";
  if (!isTerminalAllowed(email)) {
    return {
      ok: false,
      response: err(
        403,
        "terminal_not_enabled",
        "The web workspace is not enabled for this account"
      ),
    };
  }
  return { ok: true, userId };
}

/**
 * Coder-panel gate: workspace access (Clerk + SANAD_TERMINAL_EMAILS) plus the
 * stricter SANAD_CODER_PANEL_EMAILS allowlist — write-capable agent access is
 * grantable to a subset of workspace users. Both fail closed.
 */
export async function authenticateCoderPanel(): Promise<WorkspaceAuth> {
  const { userId } = await auth();
  if (!userId) {
    return { ok: false, response: err(401, "unauthorized", "Must be signed in") };
  }
  const clerkUser = await currentUser();
  const email = clerkUser?.emailAddresses[0]?.emailAddress ?? "";
  if (!isTerminalAllowed(email)) {
    return {
      ok: false,
      response: err(
        403,
        "terminal_not_enabled",
        "The web workspace is not enabled for this account"
      ),
    };
  }
  if (!isCoderPanelAllowed(email)) {
    return {
      ok: false,
      response: err(
        403,
        "coder_not_enabled",
        "The coding agent is not enabled for this account"
      ),
    };
  }
  return { ok: true, userId };
}

/**
 * Forward a request to the user's workspace, injecting service auth.
 *
 * railway mode: the shared multi-user container (secret + explicit user).
 * aws mode: the user's own machine via the router, authenticated with the
 * derived per-run bearer. A stopped machine returns 503 from the router; the
 * client surfaces it as "workspace is waking" and retries.
 */
export async function workspaceFetch(
  userId: string,
  path: string,
  init: RequestInit & { duplex?: "half"; sessionId?: string } = {}
): Promise<Response> {
  const headers = new Headers(init.headers);
  let base: string;

  const { computeMode } = await import("../compute/mode");
  if (computeMode() === "aws") {
    const { sessionTaskAuth } = await import("../compute/sessions");
    const target = await sessionTaskAuth(userId, init.sessionId);
    if (!target) {
      // No machine yet — the workspace page's session POST provisions it.
      return new Response(
        JSON.stringify({ error: { code: "workspace_not_ready", message: "Workspace is starting" } }),
        { status: 503, headers: { "content-type": "application/json" } }
      );
    }
    base = target.baseUrl;
    headers.set("authorization", `Bearer ${target.token}`);
  } else {
    const legacyBase = process.env.TERMINAL_INTERNAL_URL;
    const secret = process.env.TERMINAL_SHARED_SECRET;
    if (!legacyBase || !secret) {
      throw new Error("terminal service is not configured");
    }
    base = legacyBase;
    headers.set("x-terminal-secret", secret);
    headers.set("x-workspace-user", userId);
  }

  // Streaming request bodies (uploads, file writes) require half duplex.
  if (init.body && !init.duplex) init.duplex = "half";

  /*
   * A machine mid-stop can black-hole connections; without a bound these
   * requests hang until the platform's 60s edge timeout. The timer only
   * guards TIME-TO-HEADERS — it is cleared once the response arrives, so
   * large streamed downloads are never cut off. Uploads carry a body and
   * finish before headers, so they get the longer bound.
   */
  const timeoutMs = init.body ? 60_000 : 15_000;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${base.replace(/\/+$/, "")}${path}`, {
      ...init,
      headers,
      signal: init.signal ?? ac.signal,
    });
    return res;
  } catch (e) {
    if ((e as Error).name === "AbortError" || (e as Error).name === "TimeoutError") {
      return new Response(
        JSON.stringify({
          error: { code: "workspace_unreachable", message: "Workspace is not responding — it may be waking" },
        }),
        { status: 503, headers: { "content-type": "application/json" } }
      );
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Re-wrap an internal JSON response in the public envelope: internal
 * `{error:{code,message}}` becomes `err(...)`, anything else `ok(data)`.
 */
export async function relayJson(upstream: Response): Promise<NextResponse> {
  const body = (await upstream.json().catch(() => null)) as
    | { error?: { code?: string; message?: string } }
    | Record<string, unknown>
    | null;
  if (!upstream.ok || body === null) {
    const error = (body as { error?: { code?: string; message?: string } } | null)?.error;
    return err(
      upstream.ok ? 502 : upstream.status,
      error?.code ?? "workspace_error",
      error?.message ?? "Workspace request failed"
    );
  }
  const { ok } = await import("../http/envelope");
  return ok(body);
}

/** Relay a binary stream (file read / archive) with its metadata headers. */
export function relayStream(upstream: Response, disposition: "inline" | "attachment"): Response {
  if (!upstream.ok || !upstream.body) {
    return NextResponse.json(
      { error: { code: "workspace_error", message: "Workspace request failed" } },
      { status: upstream.ok ? 502 : upstream.status }
    );
  }
  const headers = new Headers();
  let contentType = upstream.headers.get("content-type") ?? "application/octet-stream";
  // This route must NEVER render executable HTML: an inline text/html response
  // would execute workspace content same-origin on www.sanadcode.com with the
  // user's cookies. The sandboxed /api/workspace/preview route is the only
  // sanctioned HTML renderer.
  if (disposition === "inline" && /html|xml/i.test(contentType)) {
    contentType = "text/plain; charset=utf-8";
  }
  headers.set("content-type", contentType);
  headers.set("x-content-type-options", "nosniff");
  const length = upstream.headers.get("content-length");
  if (length) headers.set("content-length", length);
  const name = upstream.headers.get("x-file-name") ?? "file";
  headers.set(
    "content-disposition",
    `${disposition}; filename="${name.replace(/["\\]/g, "_")}"`
  );
  return new Response(upstream.body, { status: 200, headers });
}
