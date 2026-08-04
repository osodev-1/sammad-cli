import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SANAD_LOGO_PATH, SANAD_LOGO_VIEWBOX } from "../../app/ui/sanadLogoPath";

/**
 * The logo is approved artwork the brand owner exported; we are not allowed to
 * redraw it. These assertions freeze the two things that would change it
 * silently — the coordinates themselves, and the viewBox they are drawn
 * against — so an accidental "tidy up" or re-scale fails here rather than
 * shipping a subtly wrong mark.
 *
 * They also pin the property that made the previous version fragile: the
 * wordmark must stay outlines. When it was live SVG <text> stretched to a fixed
 * textLength, a missing webfont rendered it at the right width in the wrong
 * letterforms — wrong in a way that looked deliberate.
 */

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p: string) => readFileSync(resolve(pkgRoot, p), "utf8");

/** sha256 of the `d` attribute as supplied by the brand owner. */
const APPROVED_GEOMETRY =
  "2c84074562de113ed0714318195287a9f83c3aedc0079a0f83790b2f658f6723";

describe("brand logo", () => {
  it("draws the approved geometry, unmodified", () => {
    const actual = createHash("sha256").update(SANAD_LOGO_PATH).digest("hex");
    expect(
      actual,
      "logo path data changed — it is approved artwork and must not be " +
        "redrawn, re-scaled or reformatted. If the brand owner supplied a new " +
        "export, update APPROVED_GEOMETRY deliberately.",
    ).toBe(APPROVED_GEOMETRY);
  });

  it("keeps the viewBox the artwork was exported against", () => {
    // Changing this rescales the mark against fixed coordinates.
    expect(SANAD_LOGO_VIEWBOX).toBe("0 0 829 357");
  });

  it("is outlines, never live text", () => {
    const component = read("app/ui/SanadLogo.tsx");
    expect(component).not.toMatch(/<text[\s>]/);
    expect(component).not.toMatch(/fontFamily|textLength|lengthAdjust/);
  });

  it("inherits colour instead of hardcoding ink", () => {
    const component = read("app/ui/SanadLogo.tsx");
    expect(component).toMatch(/fill="currentColor"/);
    // A literal hex would break the mark wherever the surface inverts.
    expect(component).not.toMatch(/fill="#/);
  });

  it("carries no webfont dependency any more", () => {
    const css = read("app/globals.css");
    expect(css).not.toMatch(/@font-face/);
    expect(css).not.toMatch(/Saira/i);
    expect(css).not.toMatch(/fonts\.googleapis\.com|fonts\.gstatic\.com/);
  });

  it("ships no font binaries", () => {
    for (const stale of [
      "public/brand/saira-black-sanad.woff2",
      "brand/Saira-Black.ttf",
      "scripts/build-logo-font.mts",
    ]) {
      expect(existsSync(resolve(pkgRoot, stale)), `${stale} should be gone`).toBe(
        false,
      );
    }
  });
});
