import type { CSSProperties, SVGProps } from "react";
import { SANAD_LOGO_PATH, SANAD_LOGO_VIEWBOX } from "./sanadLogoPath";

export type SanadLogoProps = Omit<SVGProps<SVGSVGElement>, "color"> & {
  /** Accessible name. Also kept as in-document <title> text. */
  title?: string;
  /** Any CSS colour. The whole logo is drawn with currentColor. */
  color?: CSSProperties["color"];
  /**
   * Explicit height. Omit it to let `.sanad-logo` size the mark responsively
   * (58px, dropping to 49px under 640px) — an inline height would beat the
   * stylesheet and break the mobile step-down.
   */
  height?: number | string;
  /**
   * Hide the mark from assistive tech. Use this wherever an ancestor already
   * names the control — the navbar link labels itself "sanad — home", and a
   * self-naming image inside it gets announced a second time.
   */
  decorative?: boolean;
};

/**
 * The sanad lockup: wordmark and mascot, exactly as the brand owner exported
 * them.
 *
 * The artwork is a single filled outline (see `sanadLogoPath`), not live text,
 * so there is no webfont on the critical path and no way for the mark to render
 * in a substitute face. Everything is drawn with `currentColor`, so the
 * parent's text colour flips the whole logo between ink and paper — no second
 * asset, no theme prop.
 *
 * Geometry is approved artwork and must not be redrawn: the viewBox and path
 * data are fixed. Size it, colour it, but never edit the coordinates.
 */
export function SanadLogo({
  title = "Sanad",
  color,
  height,
  decorative = false,
  className = "",
  style,
  ...svgProps
}: SanadLogoProps) {
  return (
    <svg
      {...svgProps}
      className={`sanad-logo ${className}`.trim()}
      viewBox={SANAD_LOGO_VIEWBOX}
      preserveAspectRatio="xMinYMid meet"
      focusable="false"
      {...(decorative
        ? { "aria-hidden": true }
        : { role: "img", "aria-label": title })}
      style={{
        ...(color ? { color } : null),
        ...(height !== undefined ? { height, width: "auto" } : null),
        ...style,
      }}
    >
      {!decorative && <title>{title}</title>}
      <path
        d={SANAD_LOGO_PATH}
        fill="currentColor"
        fillRule="evenodd"
        clipRule="evenodd"
      />
    </svg>
  );
}

export default SanadLogo;
