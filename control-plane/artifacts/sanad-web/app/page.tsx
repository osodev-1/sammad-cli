import Link from "next/link";
import type { CSSProperties } from "react";
import Nav from "./ui/Nav";
import TerminalFrame from "./ui/TerminalFrame";
import {
  ArrowUpRightIcon,
  BoltIcon,
  BuildingIcon,
  ChartIcon,
  KeyIcon,
} from "./ui/icons";
import { button, size, surface, type } from "./ui/theme";

export default function HomePage() {
  return (
    <div style={styles.root}>
      <Nav links={[{ href: "/pricing", label: "Pricing" }, { href: "/dashboard", label: "Dashboard" }]} />

      <main className="pad-x hero-tight" style={styles.hero}>
        <p style={styles.eyebrow}>CLI + gateway · governed AI</p>
        <h1 style={styles.h1}>
          The AI coding agent your&nbsp;team&nbsp;can&nbsp;trust
        </h1>
        <p style={styles.subtitle}>
          sanad routes every model call through a governed gateway backed by
          Azure AI Foundry. No personal API keys. No unchecked spend. One
          subscription, every model.
        </p>

        <div style={styles.heroActions}>
          <Link href="/pricing" style={button.primary(size.lg)}>
            Get started free
          </Link>
          <a
            href="https://github.com/sanadcode"
            style={button.secondary(size.lg)}
            target="_blank"
            rel="noreferrer"
          >
            View docs
            <ArrowUpRightIcon size={16} />
          </a>
        </div>

        <TerminalFrame title="sanad — zsh" style={{ maxWidth: "620px" }}>
          <pre style={styles.terminal}>{`$ npm install -g sanad
$ sanad login
  → Opening https://sanadcode.com/device?code=AXKR-7P2M …

✓ Signed in as ali@example.com (free plan)
$ sanad run "refactor this auth module"`}</pre>
        </TerminalFrame>
      </main>

      <section className="pad-x" style={styles.featuresWrap}>
        <p style={styles.sectionMark}>What you get</p>
        <div style={styles.features}>
          {FEATURES.map((f) => (
            <div key={f.title} style={styles.featureCard}>
              <span style={styles.featureIcon}>
                <f.Icon size={22} />
              </span>
              <h3 style={styles.featureTitle}>{f.title}</h3>
              <p style={styles.featureDesc}>{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      <footer className="pad-x" style={styles.footer}>
        <span>© 2026 sanad</span>
        <span style={styles.footerLinks}>
          <Link href="/pricing" className="link">
            Pricing
          </Link>
          <a href="mailto:hi@sanadcode.com" className="link">
            Contact
          </a>
        </span>
      </footer>
    </div>
  );
}

const FEATURES = [
  {
    Icon: KeyIcon,
    title: "No personal API keys",
    desc: "Users authenticate once with sanad login. The gateway holds all provider credentials — no keys ever touch developer machines.",
  },
  {
    Icon: BoltIcon,
    title: "Five frontier models",
    desc: "kimi-k2.7-code, gpt-5.3-codex, deepseek-v4-pro, codestral, mistral-small — switch in-session with /model.",
  },
  {
    Icon: BuildingIcon,
    title: "Enterprise SSO",
    desc: "Sign in with Microsoft Entra, Google Workspace, or any SAML provider. Org-scoped seats, no shadow IT.",
  },
  {
    Icon: ChartIcon,
    title: "Usage metering",
    desc: "Every token in and out is metered. Free tier, quota enforcement at the gateway — your dashboard shows the full picture.",
  },
];

const styles: Record<string, CSSProperties> = {
  root: surface.page,
  hero: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    textAlign: "center",
    padding: "7rem 2.5rem 5rem",
    maxWidth: "880px",
    margin: "0 auto",
    width: "100%",
  },
  eyebrow: { ...type.eyebrow, marginBottom: "1.75rem" },
  h1: { ...type.display, marginBottom: "1.5rem" },
  subtitle: {
    ...type.lead,
    maxWidth: "580px",
    margin: "0 auto 2.75rem",
  },
  heroActions: {
    display: "flex",
    gap: "0.85rem",
    flexWrap: "wrap",
    justifyContent: "center",
    marginBottom: "4.5rem",
  },
  terminal: {
    margin: 0,
    padding: "1.5rem",
    fontSize: "0.8rem",
    lineHeight: 1.9,
    color: "var(--invert-ink)",
    textAlign: "left",
    whiteSpace: "pre",
    overflowX: "auto",
  },
  featuresWrap: {
    maxWidth: "1040px",
    margin: "0 auto",
    padding: "0 2.5rem 6rem",
    width: "100%",
  },
  sectionMark: {
    ...type.eyebrow,
    paddingBottom: "1.25rem",
    marginBottom: "2.5rem",
    borderBottom: "1px solid var(--rule)",
  },
  features: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))",
    gap: "2.5rem 2rem",
  },
  featureCard: {
    display: "flex",
    flexDirection: "column",
    gap: "0.85rem",
    alignItems: "flex-start",
  },
  featureIcon: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "42px",
    height: "42px",
    borderRadius: "var(--radius-pill)",
    border: "1px solid var(--rule-strong)",
    color: "var(--ink)",
  },
  featureTitle: { ...type.h3 },
  featureDesc: { ...type.body, fontSize: "0.875rem" },
  footer: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: "0.75rem",
    padding: "2rem 2.5rem",
    color: "var(--ink-muted)",
    fontSize: "0.82rem",
    borderTop: "1px solid var(--rule)",
  },
  footerLinks: { display: "flex", gap: "1.25rem" },
};
