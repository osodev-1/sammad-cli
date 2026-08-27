import { NextRequest, NextResponse } from "next/server";
import { authenticateWorkspace } from "@/lib/workspace/proxy";
import { sessionPreviewHash } from "@/lib/compute/sessions";
import { previewHost } from "@/lib/compute/preview";

/**
 * Redirect to the preview origin serving `port` in the caller's workspace.
 *
 * The browser panel cannot build this URL itself: it would need the
 * workspace's `hash12`, which lives in the session grant fetched inside
 * TerminalPanel — not in scope where the browser tab renders, and not
 * guaranteed to exist yet (a browser tab can be opened before any terminal).
 * So the client points the iframe at this dumb path and the server resolves
 * the hash.
 *
 * A REDIRECT rather than a proxy, deliberately: after the 302 the document's
 * origin IS the preview origin, so the app's absolute asset paths, cookies
 * and HMR WebSocket all resolve against it. Proxying would leave every one of
 * those pointing back at sanad-web.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ port: string; path?: string[] }> },
) {
  const gate = await authenticateWorkspace();
  if (!gate.ok) return gate.response;

  const { port: rawPort, path } = await params;
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return NextResponse.json(
      { error: { code: "bad_port", message: "Not a valid port" } },
      { status: 400 },
    );
  }

  const sessionId = req.nextUrl.searchParams.get("session") ?? undefined;
  const hash12 = await sessionPreviewHash(gate.userId, sessionId);
  if (!hash12) {
    return NextResponse.json(
      { error: { code: "no_workspace", message: "No workspace to preview" } },
      { status: 404 },
    );
  }

  // Carry the sub-path and any query through, minus our own `session` scope.
  const search = new URLSearchParams(req.nextUrl.searchParams);
  search.delete("session");
  const qs = search.toString();
  const suffix = path?.length ? `/${path.map(encodeURIComponent).join("/")}` : "/";
  const target = `https://${previewHost(hash12, port)}${suffix}${qs ? `?${qs}` : ""}`;

  // 307 preserves the method; previews are GET-only here, but a 302 would let
  // a future non-GET silently become a GET.
  return NextResponse.redirect(target, 307);
}
