import { NextRequest } from "next/server";
import { err } from "@/lib/http/envelope";
import { authenticateWorkspace, workspaceFetch } from "@/lib/workspace/proxy";

/**
 * The ONLY sanctioned renderer of workspace HTML — a browser-view surface for
 * agent/user-created pages and their assets.
 *
 * Path-based (`/api/workspace/preview/site/index.html`) so relative asset
 * references inside a page resolve back through this same route. The
 * load-bearing security header is `Content-Security-Policy: sandbox`: the
 * document gets an OPAQUE ORIGIN even when the URL is opened top-level, so
 * workspace content can never touch www.sanadcode.com cookies, storage, or
 * DOM. `frame-ancestors 'self'` stops other sites from framing previews. The
 * embedding side adds `<iframe sandbox="allow-scripts allow-forms">` as a
 * second, independent layer.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const gate = await authenticateWorkspace();
  if (!gate.ok) return gate.response;

  const { path: segments } = await params;
  const relPath = (segments ?? []).join("/");
  if (!relPath) return err(400, "invalid_request", "Missing path");

  const upstream = await workspaceFetch(
    gate.userId,
    `/internal/workspace/file?path=${encodeURIComponent(relPath)}`
  );
  if (!upstream.ok || !upstream.body) {
    return err(
      upstream.status === 404 ? 404 : 502,
      upstream.status === 404 ? "not_found" : "workspace_error",
      upstream.status === 404 ? "File not found" : "Workspace request failed"
    );
  }

  const headers = new Headers();
  headers.set(
    "content-type",
    upstream.headers.get("content-type") ?? "application/octet-stream"
  );
  const length = upstream.headers.get("content-length");
  if (length) headers.set("content-length", length);
  headers.set(
    "content-security-policy",
    "sandbox allow-scripts allow-forms; frame-ancestors 'self'"
  );
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  headers.set("cache-control", "no-store");

  return new Response(upstream.body, { status: 200, headers });
}
