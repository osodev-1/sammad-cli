import type { CSSProperties } from "react";

/*
 * Monochrome line icons. Everything draws with `currentColor` so an icon
 * always inherits the ink of whatever surface it sits on — no colour, ever.
 */

interface IconProps {
  size?: number;
  strokeWidth?: number;
  style?: CSSProperties;
}

function Svg({
  size = 20,
  strokeWidth = 1.5,
  style,
  children,
}: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={{ display: "block", flexShrink: 0, ...style }}
    >
      {children}
    </svg>
  );
}

/* --- Feature marks --- */

export function KeyIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="8" cy="12" r="4" />
      <path d="M12 12h9" />
      <path d="M17 12v3.5" />
      <path d="M20 12v2.5" />
    </Svg>
  );
}

export function BoltIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M13 2 4.5 13.5H11L10 22l8.5-11.5H12L13 2Z" />
    </Svg>
  );
}

export function BuildingIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 21h16" />
      <path d="M6 21V4.5A1.5 1.5 0 0 1 7.5 3h6A1.5 1.5 0 0 1 15 4.5V21" />
      <path d="M15 10h3.5A1.5 1.5 0 0 1 20 11.5V21" />
      <path d="M9 7h3M9 11h3M9 15h3" />
    </Svg>
  );
}

export function ChartIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 3v16.5A1.5 1.5 0 0 0 5.5 21H21" />
      <path d="M8 16v-4" />
      <path d="M12.5 16V7" />
      <path d="M17 16v-6" />
    </Svg>
  );
}

/* --- State marks --- */

/**
 * Success: a solid disc (in the current ink) with a knocked-out check.
 * On an already-inverted surface pass `knockout` so the tick stays legible.
 */
export function CheckSolidIcon({
  size = 18,
  style,
  knockout = "var(--paper)",
}: IconProps & { knockout?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      style={{ display: "block", flexShrink: 0, ...style }}
    >
      <circle cx="12" cy="12" r="11" fill="currentColor" />
      <path
        d="m7 12.5 3.2 3.2L17 9"
        fill="none"
        stroke={knockout}
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Plain check used in dense lists (feature rows). */
export function CheckIcon(props: IconProps) {
  return (
    <Svg strokeWidth={2.25} {...props}>
      <path d="m4.5 12.5 5 5L19.5 7" />
    </Svg>
  );
}

/** Danger / denial: outlined ring with a hard X — the inverse of success. */
export function CrossOutlineIcon({ size = 18, strokeWidth = 2, style }: IconProps) {
  return (
    <Svg size={size} strokeWidth={strokeWidth} style={style}>
      <circle cx="12" cy="12" r="10" />
      <path d="m8.5 8.5 7 7M15.5 8.5l-7 7" />
    </Svg>
  );
}

/** Warning: heavy triangle, carries weight instead of amber. */
export function AlertTriangleIcon({ size = 18, strokeWidth = 2, style }: IconProps) {
  return (
    <Svg size={size} strokeWidth={strokeWidth} style={style}>
      <path d="M12 3.5 1.8 20.5h20.4L12 3.5Z" />
      <path d="M12 9.5v5" />
      <path d="M12 17.8v.01" />
    </Svg>
  );
}

export function PowerIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 3v8" />
      <path d="M5.6 6.6a9 9 0 1 0 12.8 0" />
    </Svg>
  );
}

export function ArrowUpRightIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M7 17 17 7" />
      <path d="M8 7h9v9" />
    </Svg>
  );
}

export function ArrowLeftIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M19 12H5" />
      <path d="m11 6-6 6 6 6" />
    </Svg>
  );
}
