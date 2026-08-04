import type { CSSProperties } from "react";

/*
 * "Printed Terminal" — the shared control vocabulary.
 *
 * Every page draws its buttons, cards, inputs and state markers from here so
 * the five surfaces read as one product. Strictly achromatic: state is carried
 * by fill, weight, border and iconography rather than hue.
 */

/* ---------------------------------------------------------------- type --- */

export const type = {
  display: {
    margin: 0,
    fontSize: "clamp(2.25rem, 5.5vw, 3.9rem)",
    fontWeight: 700,
    lineHeight: 1.06,
    letterSpacing: "-0.045em",
    color: "var(--ink)",
  } as CSSProperties,
  h1: {
    margin: 0,
    fontSize: "clamp(1.6rem, 3.2vw, 2.1rem)",
    fontWeight: 700,
    lineHeight: 1.15,
    letterSpacing: "-0.03em",
    color: "var(--ink)",
  } as CSSProperties,
  h2: {
    margin: 0,
    fontSize: "1.15rem",
    fontWeight: 700,
    letterSpacing: "-0.02em",
    color: "var(--ink)",
  } as CSSProperties,
  h3: {
    margin: 0,
    fontSize: "1rem",
    fontWeight: 650,
    letterSpacing: "-0.015em",
    color: "var(--ink)",
  } as CSSProperties,
  /* Mono, letter-spaced section marker — the recurring "terminal" accent. */
  eyebrow: {
    margin: 0,
    fontFamily: "var(--font-mono)",
    fontSize: "0.7rem",
    fontWeight: 500,
    letterSpacing: "0.16em",
    textTransform: "uppercase",
    color: "var(--ink-muted)",
  } as CSSProperties,
  lead: {
    margin: 0,
    fontSize: "1.075rem",
    lineHeight: 1.7,
    color: "var(--ink-soft)",
  } as CSSProperties,
  body: {
    margin: 0,
    fontSize: "0.925rem",
    lineHeight: 1.65,
    color: "var(--ink-soft)",
  } as CSSProperties,
  small: {
    margin: 0,
    fontSize: "0.8rem",
    lineHeight: 1.55,
    color: "var(--ink-muted)",
  } as CSSProperties,
  mono: {
    fontFamily: "var(--font-mono)",
    fontSize: "0.82rem",
    color: "var(--ink)",
  } as CSSProperties,
};

/* ------------------------------------------------------------- buttons --- */

const buttonBase: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: "0.5rem",
  borderRadius: "var(--radius-pill)",
  border: "1px solid transparent",
  fontFamily: "inherit",
  fontWeight: 600,
  lineHeight: 1.2,
  textDecoration: "none",
  whiteSpace: "nowrap",
  cursor: "pointer",
  transition: "background 0.18s ease, color 0.18s ease, border-color 0.18s ease",
};

export const size = {
  sm: { padding: "0.4rem 0.9rem", fontSize: "0.8rem" } as CSSProperties,
  md: { padding: "0.6rem 1.3rem", fontSize: "0.9rem" } as CSSProperties,
  lg: { padding: "0.85rem 1.9rem", fontSize: "1rem" } as CSSProperties,
};

export const button = {
  /** Solid ink pill — the single primary action on a surface. */
  primary: (s: CSSProperties = size.md): CSSProperties => ({
    ...buttonBase,
    ...s,
    background: "var(--ink)",
    color: "var(--paper)",
    borderColor: "var(--ink)",
  }),
  /** Outlined pill on paper — secondary, always neutral in tone. */
  secondary: (s: CSSProperties = size.md): CSSProperties => ({
    ...buttonBase,
    ...s,
    background: "var(--paper)",
    color: "var(--ink)",
    borderColor: "var(--rule-strong)",
  }),
  /** Quiet tertiary — underlined text, no chrome. */
  quiet: (s: CSSProperties = size.sm): CSSProperties => ({
    ...buttonBase,
    ...s,
    background: "none",
    border: "none",
    padding: 0,
    color: "var(--ink-soft)",
    fontWeight: 500,
    textDecoration: "underline",
    textUnderlineOffset: "3px",
    textDecorationColor: "var(--rule-strong)",
  }),
  /**
   * Destructive — deliberately unlike the neutral secondary: a heavier ink
   * border, bold letter-spaced label and an explicit icon. Reads as "careful"
   * without a single red pixel.
   */
  danger: (s: CSSProperties = size.sm): CSSProperties => ({
    ...buttonBase,
    ...s,
    background: "var(--paper)",
    color: "var(--ink)",
    border: "1.5px solid var(--ink)",
    fontWeight: 700,
    letterSpacing: "0.02em",
  }),
  /** The confirmed destructive step — inverted, the heaviest control we have. */
  dangerConfirm: (s: CSSProperties = size.sm): CSSProperties => ({
    ...buttonBase,
    ...s,
    background: "var(--ink)",
    color: "var(--paper)",
    border: "1.5px solid var(--ink)",
    fontWeight: 700,
    letterSpacing: "0.02em",
  }),
  /** Inverted primary, for use on the black terminal surface. */
  onInvert: (s: CSSProperties = size.md): CSSProperties => ({
    ...buttonBase,
    ...s,
    background: "var(--paper)",
    color: "var(--ink)",
    borderColor: "var(--paper)",
  }),
};

export const disabled = (on: boolean): CSSProperties =>
  on ? { opacity: 0.45, cursor: "not-allowed" } : {};

/* ------------------------------------------------------- cards & shell --- */

export const surface = {
  page: {
    minHeight: "100vh",
    background: "var(--paper)",
    display: "flex",
    flexDirection: "column",
  } as CSSProperties,
  /** White card, hairline border, generous padding. */
  card: {
    background: "var(--paper)",
    border: "1px solid var(--rule)",
    borderRadius: "var(--radius-lg)",
    padding: "1.75rem",
  } as CSSProperties,
  cardLifted: {
    background: "var(--paper)",
    border: "1px solid var(--rule)",
    borderRadius: "var(--radius-lg)",
    padding: "2.25rem",
    boxShadow: "var(--shadow-soft)",
  } as CSSProperties,
  /** The inverted block — terminal demo, focal panels. */
  invert: {
    background: "var(--invert-surface)",
    color: "var(--invert-ink)",
    borderRadius: "var(--radius-lg)",
    border: "1px solid var(--invert-surface)",
    overflow: "hidden",
  } as CSSProperties,
  /** Hairline rule used to separate rows instead of boxing them. */
  rule: {
    border: "none",
    borderTop: "1px solid var(--rule)",
    margin: 0,
  } as CSSProperties,
  section: { marginBottom: "3rem" } as CSSProperties,
};

export const input: CSSProperties = {
  background: "var(--paper)",
  border: "1px solid var(--rule-strong)",
  borderRadius: "var(--radius-pill)",
  padding: "0.6rem 1.15rem",
  fontSize: "0.9rem",
  color: "var(--ink)",
  outline: "none",
};

/* ------------------------------------------------- semantic state, sans --- */
/* ------------------------------------------------------------- colour  --- */

/** Diagonal hatch — the stand-in for "caution" now that amber is gone. */
export const hatch = (opacity = 0.18, gap = 7): string =>
  `repeating-linear-gradient(45deg, rgba(10,10,10,${opacity}) 0 2px, transparent 2px ${gap}px)`;

export const state = {
  /** Success — solid ink fill, knocked-out label. Maximum contrast. */
  successBadge: {
    display: "inline-flex",
    alignItems: "center",
    gap: "0.5rem",
    background: "var(--ink)",
    color: "var(--paper)",
    border: "1.5px solid var(--ink)",
    borderRadius: "var(--radius-pill)",
    padding: "0.45rem 1.05rem",
    fontSize: "0.85rem",
    fontWeight: 700,
    letterSpacing: "0.01em",
  } as CSSProperties,
  /** Danger — the exact inverse: outlined, heavy, with a cross mark. */
  dangerBadge: {
    display: "inline-flex",
    alignItems: "center",
    gap: "0.5rem",
    background: "var(--paper)",
    color: "var(--ink)",
    border: "1.5px solid var(--ink)",
    borderRadius: "var(--radius-pill)",
    padding: "0.45rem 1.05rem",
    fontSize: "0.85rem",
    fontWeight: 700,
    letterSpacing: "0.01em",
  } as CSSProperties,
  /** Neutral / inactive — hairline outline, muted ink, no weight. */
  neutralBadge: {
    display: "inline-flex",
    alignItems: "center",
    gap: "0.4rem",
    background: "var(--paper)",
    color: "var(--ink-muted)",
    border: "1px solid var(--rule-strong)",
    borderRadius: "var(--radius-pill)",
    padding: "0.25rem 0.7rem",
    fontSize: "0.75rem",
    fontWeight: 500,
  } as CSSProperties,
  /** Warning panel — heavy border plus hatched ground. */
  warningPanel: {
    display: "flex",
    gap: "0.7rem",
    alignItems: "flex-start",
    border: "1.5px solid var(--ink)",
    borderRadius: "var(--radius-md)",
    backgroundImage: hatch(0.1, 8),
    padding: "0.85rem 1.05rem",
    color: "var(--ink)",
    fontSize: "0.85rem",
    lineHeight: 1.55,
  } as CSSProperties,
  /** Error panel — inverted so a failure can never be skimmed past. */
  errorPanel: {
    display: "flex",
    gap: "0.7rem",
    alignItems: "flex-start",
    background: "var(--invert-surface)",
    color: "var(--invert-ink)",
    border: "1.5px solid var(--ink)",
    borderRadius: "var(--radius-md)",
    padding: "0.85rem 1.05rem",
    fontSize: "0.85rem",
    lineHeight: 1.55,
  } as CSSProperties,
  /** Confirmation panel — heavy outline, no fill, reserved for "are you sure". */
  confirmPanel: {
    display: "flex",
    alignItems: "center",
    gap: "0.75rem",
    flexWrap: "wrap",
    border: "1.5px solid var(--ink)",
    borderRadius: "var(--radius-pill)",
    padding: "0.4rem 0.4rem 0.4rem 1rem",
  } as CSSProperties,
};

/** Plan / status chip in the nav — mono, outlined, uppercase. */
export const chip: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "0.68rem",
  fontWeight: 600,
  letterSpacing: "0.12em",
  color: "var(--ink)",
  border: "1px solid var(--rule-strong)",
  borderRadius: "var(--radius-pill)",
  padding: "0.2rem 0.65rem",
  textTransform: "uppercase",
};
