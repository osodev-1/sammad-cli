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

/** Forward a request to the terminal service, injecting service auth headers. */
export async function workspaceFetch(
  userId: string,
  path: string,
  init: RequestInit & { duplex?: "half" } = {}
): Promise<Response> {
  const base = process.env.TERMINAL_INTERNAL_URL;
  const secret = process.env.TERMINAL_SHARED_SECRET;
  if (!base || !secret) {
    throw new Error("terminal service is not configured");
  }
  const headers = new Headers(init.headers);
  headers.set("x-terminal-secret", secret);
  headers.set("x-workspace-user", userId);
  // Streaming request bodies (uploads, file writes) require half duplex.
  if (init.body && !init.duplex) init.duplex = "half";
  return fetch(`${base.replace(/\/+$/, "")}${path}`, { ...init, headers });
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
  headers.set("content-type", upstream.headers.get("content-type") ?? "application/octet-stream");
  const length = upstream.headers.get("content-length");
  if (length) headers.set("content-length", length);
  const name = upstream.headers.get("x-file-name") ?? "file";
  headers.set(
    "content-disposition",
    `${disposition}; filename="${name.replace(/["\\]/g, "_")}"`
  );
  return new Response(upstream.body, { status: 200, headers });
}
