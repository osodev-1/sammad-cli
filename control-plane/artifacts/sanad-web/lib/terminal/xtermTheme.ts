import type { ITerminalOptions, ITheme } from "@xterm/xterm"; // type-only: erased at compile

/** The workspace renders in either mode; the marketing pages stay light. */
export type ThemeMode = "light" | "dark";

const THEME_STORAGE_KEY = "sanad-ws-theme";

/** Stored choice wins; otherwise follow the OS. Safe to call only client-side. */
export function readThemeMode(): ThemeMode {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    /* storage blocked — fall through to the media query */
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

export function persistThemeMode(mode: ThemeMode): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    /* storage blocked — the choice just won't survive a reload */
  }
}

/**
 * "Printed Terminal" on black. Background/foreground restate --invert-surface
 * and --invert-ink from globals.css — xterm cannot read CSS custom properties.
 *
 * The ANSI ramp is deliberately desaturated: greys with just enough hue that
 * diffs (red/green), warnings (yellow) and prompts stay legible without
 * putting a rainbow block in an otherwise achromatic site. Normal colors clear
 * ~4.5:1 on #0a0a0a; minimumContrastRatio backstops anything drawn on other
 * backgrounds.
 */
export const XTERM_THEME: ITheme = {
  background: "#0a0a0a",
  foreground: "#f5f5f5",
  cursor: "#f5f5f5",
  cursorAccent: "#0a0a0a",
  selectionBackground: "rgba(245,245,245,0.30)",
  selectionInactiveBackground: "rgba(245,245,245,0.16)",

  black: "#1a1a1a",
  red: "#c65f58", // muted brick — errors, diff minus
  green: "#7fae7a", // sage — success, diff plus
  yellow: "#c2a061", // ochre — warnings
  blue: "#8b9bb4", // slate
  magenta: "#a58fae", // dusty mauve
  cyan: "#84a8a3", // grey-teal
  white: "#d6d6d6",

  brightBlack: "#767676",
  brightRed: "#d98a83",
  brightGreen: "#a3c99e",
  brightYellow: "#d6ba82",
  brightBlue: "#aebccf",
  brightMagenta: "#c1abc8",
  brightCyan: "#a7c4bf",
  brightWhite: "#ffffff",
};

/**
 * The light twin: the same desaturated hues pushed dark enough to clear
 * ~4.5:1 on the sunken-paper ground, so a light workspace reads as ink on
 * paper rather than a black slab in a white page.
 */
export const XTERM_THEME_LIGHT: ITheme = {
  background: "#f7f7f7",
  foreground: "#1a1a1a",
  cursor: "#1a1a1a",
  cursorAccent: "#f7f7f7",
  selectionBackground: "rgba(10,10,10,0.18)",
  selectionInactiveBackground: "rgba(10,10,10,0.10)",

  black: "#2a2a2a",
  red: "#9c3f38", // muted brick — errors, diff minus
  green: "#3f6f3a", // sage — success, diff plus
  yellow: "#7d6023", // ochre — warnings
  blue: "#45597a", // slate
  magenta: "#6d5876", // dusty mauve
  cyan: "#3f6a64", // grey-teal
  white: "#c9c9c9",

  brightBlack: "#5c5c5c",
  brightRed: "#b04a41",
  brightGreen: "#4f8a49",
  brightYellow: "#94722a",
  brightBlue: "#556e94",
  brightMagenta: "#7f6889",
  brightCyan: "#4d817a",
  brightWhite: "#ffffff",
};

export const XTERM_THEMES: Record<ThemeMode, ITheme> = {
  dark: XTERM_THEME,
  light: XTERM_THEME_LIGHT,
};

/**
 * The terminal panel's ground, restated for React containers (padding,
 * overlays) so the DOM around the canvas always matches the xterm theme.
 */
export const TERM_SURFACE: Record<ThemeMode, string> = {
  dark: "#0a0a0a",
  light: "#f7f7f7",
};

/**
 * The landing card runs 0.8rem/1.9 — display typography. A working terminal
 * at lineHeight 1.9 tears TUI frames apart, so the live grid runs 13px/1.4;
 * the shared TerminalFrame chrome carries the family resemblance. fontFamily
 * mirrors --font-mono exactly (no webfont is loaded — users get their
 * platform mono, same as the demo card).
 */
export const XTERM_OPTIONS: ITerminalOptions = {
  fontFamily:
    '"JetBrains Mono", "Fira Code", "Cascadia Code", ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 13,
  lineHeight: 1.4,
  fontWeight: 400,
  fontWeightBold: 700,
  letterSpacing: 0,
  cursorBlink: true,
  cursorStyle: "block",
  scrollback: 5000,
  minimumContrastRatio: 4.5,
  allowProposedApi: true,
  theme: XTERM_THEME,
};
