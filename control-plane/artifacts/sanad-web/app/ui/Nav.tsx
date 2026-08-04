"use client";

import Link from "next/link";
import type { CSSProperties } from "react";
import { SignedIn, SignedOut, SignInButton, UserButton } from "@clerk/nextjs";
import { button, chip, size } from "./theme";
import SanadLogo from "./SanadLogo";

export interface NavLink {
  href: string;
  label: string;
  /** Hidden below 640px to keep the bar to one line on phones. */
  compactHidden?: boolean;
}

interface Props {
  /** Links shown between the wordmark and the account controls. */
  links?: NavLink[];
  /** Current plan, rendered as a mono chip beside the avatar. */
  planBadge?: string;
}

const DEFAULT_LINKS: NavLink[] = [
  { href: "/pricing", label: "Pricing" },
  { href: "/dashboard", label: "Dashboard" },
];

/**
 * The single navigation bar for every page. Signed-out visitors get a solid
 * ink "Sign in" pill; signed-in users get their plan chip and avatar.
 */
export default function Nav({ links = DEFAULT_LINKS, planBadge }: Props) {
  return (
    <nav className="pad-x" style={s.nav}>
      <Link href="/" style={s.brand} aria-label="sanad — home">
        <SanadLogo decorative />
      </Link>

      <div className="nav-links" style={s.right}>
        {links.map((l) => (
          <Link
            key={l.href}
            href={l.href}
            className={l.compactHidden ? "nav-hide-sm" : undefined}
            style={s.link}
          >
            {l.label}
          </Link>
        ))}

        <SignedOut>
          <SignInButton mode="modal">
            <button style={button.primary(size.sm)}>Sign in</button>
          </SignInButton>
        </SignedOut>

        <SignedIn>
          {planBadge && (
            <span className="nav-hide-sm" style={chip}>
              {planBadge}
            </span>
          )}
          <UserButton />
        </SignedIn>
      </div>
    </nav>
  );
}

const s: Record<string, CSSProperties> = {
  nav: {
    position: "sticky",
    top: 0,
    zIndex: 100,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "1rem",
    padding: "0.9rem 2.5rem",
    borderBottom: "1px solid var(--rule)",
    background: "rgba(255,255,255,0.85)",
    backdropFilter: "blur(12px)",
  },
  /* Sets the ink the logo inherits; .sanad-logo owns its own sizing. */
  brand: {
    display: "inline-flex",
    alignItems: "center",
    color: "var(--ink)",
    textDecoration: "none",
  },
  right: {
    display: "flex",
    alignItems: "center",
    gap: "1.6rem",
  },
  link: {
    fontSize: "0.875rem",
    color: "var(--ink-soft)",
    textDecoration: "none",
  },
};
