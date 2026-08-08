import type { CSSProperties } from "react";
import { auth } from "@clerk/nextjs/server";
import { db } from "@/lib/db";
import { subscriptions } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
import Nav from "../ui/Nav";
import { CheckIcon } from "../ui/icons";
import { surface, type } from "../ui/theme";
import PricingCTA from "./PricingCTA";
import { PLAN_QUOTA } from "@/lib/billing/plans";

/*
 * Allowance copy is derived from the enforced quota rather than typed by hand.
 * Pro previously advertised "Unlimited requests" while the gate enforced a real
 * cap — deriving it means the page cannot promise a limit the API won't honour.
 */
const tokensLabel = (n: number) =>
  n >= 1_000_000 ? `${n / 1_000_000}M` : n.toLocaleString();

const allowance = (plan: keyof typeof PLAN_QUOTA) => [
  `${PLAN_QUOTA[plan].requestsPerMonth.toLocaleString()} requests / month`,
  `${tokensLabel(PLAN_QUOTA[plan].tokensPerMonth)} tokens / month`,
];

const PLANS = [
  {
    name: "Free",
    price: "$0",
    period: "/month",
    highlight: false,
    features: [
      ...allowance("free"),
      "All 5 models",
      "1 active CLI session",
      "Basic usage dashboard",
      "Community support",
    ],
    cta: "Get started",
  },
  {
    name: "Pro",
    price: "$19",
    period: "/month",
    highlight: true,
    features: [
      ...allowance("pro"),
      "All 5 models + thinking modes",
      "5 active CLI sessions",
      "Full usage analytics",
      "Priority support",
    ],
    cta: "Upgrade to Pro",
  },
  {
    name: "Team",
    price: "$49",
    period: "/seat/month",
    highlight: false,
    features: [
      "Everything in Pro",
      ...allowance("team"),
      "Org-scoped subscriptions",
      "Seat management",
      "Enterprise SSO (SAML / Entra)",
      "SLA + dedicated support",
    ],
    cta: "Contact sales",
  },
];

export default async function PricingPage() {
  const { userId } = await auth();

  // Fetch current plan so we can highlight it
  let currentPlan: string | undefined;
  if (userId) {
    const orgId = `personal_${userId}`;
    const [sub] = await db
      .select()
      .from(subscriptions)
      .where(
        and(eq(subscriptions.orgId, orgId), eq(subscriptions.status, "active")),
      )
      .limit(1);
    currentPlan = sub?.plan;
  }

  return (
    <div style={styles.root}>
      <Nav
        links={[
          { href: "/terminal", label: "Workspace", badge: "beta" },
          { href: "/dashboard", label: "Dashboard" },
          { href: "/usage", label: "Usage" },
        ]}
      />

      <main className="pad-x" style={styles.main}>
        <p style={styles.eyebrow}>Pricing</p>
        <h1 style={styles.h1}>Simple, transparent pricing</h1>
        <p style={styles.sub}>
          Start free. Upgrade when you need more. Enterprise billing coming in
          Q4.
        </p>

        <div style={styles.grid}>
          {PLANS.map((plan) => (
            <div
              key={plan.name}
              style={{
                ...styles.card,
                ...(plan.highlight ? styles.cardHighlight : {}),
              }}
            >
              {/* The recommended tier is marked by an inverted header and a
                  heavier border — never by a colour accent. */}
              <div
                style={
                  plan.highlight ? styles.cardBanner : styles.cardBannerEmpty
                }
              >
                {plan.highlight ? "Most popular" : ""}
              </div>

              <div style={styles.cardBody}>
                <h2 style={styles.planName}>{plan.name}</h2>
                <div style={styles.priceRow}>
                  <span style={styles.price}>{plan.price}</span>
                  <span style={styles.period}>{plan.period}</span>
                </div>

                <ul style={styles.featureList}>
                  {plan.features.map((f) => (
                    <li key={f} style={styles.featureItem}>
                      <span style={styles.check}>
                        <CheckIcon size={13} />
                      </span>
                      {f}
                    </li>
                  ))}
                </ul>

                <PricingCTA
                  plan={plan.name}
                  cta={plan.cta}
                  isHighlight={plan.highlight}
                  isSignedIn={Boolean(userId)}
                  currentPlan={currentPlan}
                />
              </div>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  root: surface.page,
  main: {
    maxWidth: "1040px",
    margin: "0 auto",
    padding: "5.5rem 2.5rem 6rem",
    textAlign: "center",
    width: "100%",
  },
  eyebrow: { ...type.eyebrow, marginBottom: "1.5rem" },
  h1: {
    ...type.display,
    fontSize: "clamp(1.9rem, 4.2vw, 3rem)",
    marginBottom: "1rem",
  },
  sub: {
    ...type.lead,
    margin: "0 auto 4rem",
    maxWidth: "460px",
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(258px, 1fr))",
    gap: "1.5rem",
    textAlign: "left",
    alignItems: "stretch",
  },
  card: {
    background: "var(--paper)",
    border: "1px solid var(--rule)",
    borderRadius: "var(--radius-lg)",
    overflow: "hidden",
    display: "flex",
    flexDirection: "column",
  },
  cardHighlight: {
    border: "1.5px solid var(--ink)",
    boxShadow: "var(--shadow-soft)",
  },
  cardBanner: {
    height: "34px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "var(--invert-surface)",
    color: "var(--invert-ink)",
    fontFamily: "var(--font-mono)",
    fontSize: "0.68rem",
    fontWeight: 600,
    letterSpacing: "0.16em",
    textTransform: "uppercase",
  },
  /* Same height as the inverted banner so every tier's price sits on one line. */
  cardBannerEmpty: {
    height: "34px",
    borderBottom: "1px solid var(--rule)",
  },
  cardBody: {
    padding: "2rem",
    display: "flex",
    flexDirection: "column",
    gap: "1.15rem",
    flex: 1,
  },
  planName: { ...type.h3, fontSize: "0.95rem", letterSpacing: "0.02em" },
  priceRow: { display: "flex", alignItems: "baseline", gap: "5px" },
  price: {
    fontSize: "2.6rem",
    fontWeight: 700,
    letterSpacing: "-0.045em",
    lineHeight: 1,
    color: "var(--ink)",
  },
  period: { color: "var(--ink-muted)", fontSize: "0.85rem" },
  featureList: {
    listStyle: "none",
    padding: "1.15rem 0 0",
    margin: 0,
    borderTop: "1px solid var(--rule)",
    flex: 1,
    display: "flex",
    flexDirection: "column",
    gap: "0.7rem",
  },
  featureItem: {
    fontSize: "0.875rem",
    color: "var(--ink-soft)",
    display: "flex",
    gap: "0.6rem",
    alignItems: "flex-start",
    lineHeight: 1.5,
  },
  /* Included = a solid ink disc with a knocked-out tick. */
  check: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "18px",
    height: "18px",
    minWidth: "18px",
    marginTop: "2px",
    borderRadius: "999px",
    background: "var(--ink)",
    color: "var(--paper)",
  },
};
