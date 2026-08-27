import { describe, it, expect, afterEach } from "vitest";
import { parseLocalTarget, previewHost, previewSuffix } from "@/lib/compute/preview";
import { previewUrl } from "@/lib/terminal/workspace-model";

/**
 * A dev server running INSIDE the workspace container has to be reachable
 * from the browser panel. It never was: `previewUrl` passed any absolute
 * http(s) URL through verbatim, so `http://localhost:3000` was resolved by
 * the user's own browser against their laptop — where nothing is listening.
 * The container's port was unreachable by construction.
 */
describe("parseLocalTarget", () => {
  it.each([
    ["3000", 3000, "/"],
    [":3000", 3000, "/"],
    ["localhost:3000", 3000, "/"],
    ["LOCALHOST:8080", 8080, "/"],
    ["127.0.0.1:5173", 5173, "/"],
    ["0.0.0.0:4321", 4321, "/"],
    ["http://localhost:3000", 3000, "/"],
    ["https://127.0.0.1:5173/nested/page", 5173, "/nested/page"],
    ["localhost:3000/a/b", 3000, "/a/b"],
  ])("parses %s", (input, port, path) => {
    expect(parseLocalTarget(input)).toEqual({ port, path });
  });

  it.each([
    "https://example.com",
    "http://example.com:3000",
    "site/index.html",
    "",
    "localhost:0",
    "localhost:99999",
    "notaport",
  ])("does NOT claim %s", (input) => {
    expect(parseLocalTarget(input)).toBeNull();
  });
});

describe("previewHost", () => {
  it("builds <hash>-<port><suffix>, matching the router's own parser", () => {
    expect(previewHost("abc123def456", 3000)).toBe(
      `abc123def456-3000${previewSuffix()}`,
    );
  });
});

describe("previewUrl", () => {
  it("routes a container port to the preview redirect, not the user's laptop", () => {
    expect(previewUrl("localhost:3000", "s1")).toBe(
      "/api/workspace/port/3000?session=s1",
    );
    expect(previewUrl("http://127.0.0.1:5173/app/index.html")).toBe(
      "/api/workspace/port/5173/app/index.html",
    );
  });

  it("an ARBITRARY port works, not just the four well-known ones", () => {
    expect(previewUrl("localhost:4321")).toBe("/api/workspace/port/4321");
  });

  it("still passes a genuine external URL straight through", () => {
    expect(previewUrl("https://example.com/x")).toBe("https://example.com/x");
  });

  it("still serves workspace-relative paths from the static preview route", () => {
    expect(previewUrl("site/index.html", "s1")).toBe(
      "/api/workspace/preview/site/index.html?session=s1",
    );
  });
});
