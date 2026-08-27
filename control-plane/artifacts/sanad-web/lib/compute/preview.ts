/**
 * Preview origins — how a port inside a workspace container becomes a URL.
 *
 * The router (control-plane/artifacts/router) already routes
 * `<hash12>-<port>.preview.sanadcode.com` to `task:<port>`, proxying
 * WebSocket upgrades and rewriting `frame-ancestors` so the page embeds in
 * the workspace. A SUBDOMAIN rather than a path prefix is what makes it a
 * real preview: the document's origin becomes the app's own, so absolute
 * asset paths (`/assets/x.js`), cookies, and HMR sockets all resolve the way
 * they would in local development. Serving under a path would break every one
 * of those unless the app were configured with a matching base path, which
 * cannot be imposed on arbitrary projects.
 */

/** `.preview.sanadcode.com` — must match the router's own `PREVIEW_SUFFIX`. */
export function previewSuffix(): string {
  return process.env.PREVIEW_SUFFIX ?? ".preview.sanadcode.com";
}

/** The hostname serving `port` for the workspace identified by `hash12`. */
export function previewHost(hash12: string, port: number): string {
  return `${hash12}-${port}${previewSuffix()}`;
}

/**
 * Parse a port the user typed. Accepts the shapes a developer actually reaches
 * for — `3000`, `:3000`, `localhost:3000`, `127.0.0.1:3000/some/path`,
 * `0.0.0.0:3000`, `http://localhost:3000/x` — and returns the port plus the
 * path to preserve. Returns null for anything else, so genuine external URLs
 * keep passing through untouched.
 */
export function parseLocalTarget(
  input: string,
): { port: number; path: string } | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const m = trimmed.match(
    /^(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|0\.0\.0\.0)?:?(\d{1,5})(\/[^\s]*)?$/i,
  );
  if (!m) return null;
  const port = Number(m[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { port, path: m[2] || "/" };
}
