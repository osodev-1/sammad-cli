import type { ITerminalOptions, ITheme } from "@xterm/xterm"; // type-only: erased at compile

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
