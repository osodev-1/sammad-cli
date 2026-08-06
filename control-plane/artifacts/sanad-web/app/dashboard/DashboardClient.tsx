"use client";

import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import Link from "next/link";
import Nav from "../ui/Nav";
import {
  AlertTriangleIcon,
  CheckSolidIcon,
  CrossOutlineIcon,
  PowerIcon,
} from "../ui/icons";
import { button, disabled, size, state, surface, type } from "../ui/theme";
import {
  usageAlert,
  USAGE_LEVEL_LABEL,
  type DimensionStatus,
  type UsageLevel,
  type UsageStatus,
} from "@/lib/billing/usage";

/**
 * Alert hues, the one place this interface departs from black and white.
 * Colour is layered on top of the existing weight / label / icon encoding —
 * never the sole signal, so the meter still reads in greyscale.
 */
const TONE: Record<UsageLevel, { ink: string; wash: string }> = {
  ok: { ink: "var(--ok-ink)", wash: "var(--ok-wash)" },
  warning: { ink: "var(--warn-ink)", wash: "var(--warn-wash)" },
  critical: { ink: "var(--crit-ink)", wash: "var(--crit-wash)" },
  exceeded: { ink: "var(--crit-ink)", wash: "var(--crit-wash)" },
};

interface Props {
  orgName: string;
  plan: string;
  /**
   * Computed on the server by the same helper the runtime-token gate uses, so
   * the meter cannot claim "healthy" while the API is refusing to mint tokens.
   */
  usage: UsageStatus;
  hasStripeCustomer: boolean;
  currentPeriodEnd: string | null;
  /** ISO start of the current billing window — scopes alert dismissal. */
  periodStart: string;
  usageByModel: {
    alias: string;
    requests: number;
    tokensIn: number;
    tokensOut: number;
  }[];
  sessions: {
    id: string;
    deviceLabel: string;
    createdAt: string;
    lastUsedAt: string | null;
  }[];
}

export default function DashboardClient({
  orgName,
  plan,
  usage,
  hasStripeCustomer,
  currentPeriodEnd,
  periodStart,
  usageByModel,
  sessions: initialSessions,
}: Props) {
  const [sessions, setSessions] = useState(initialSessions);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [revokingAll, setRevokingAll] = useState(false);
  const [confirmingRevokeAll, setConfirmingRevokeAll] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const [portalLoading, setPortalLoading] = useState(false);
  const [portalError, setPortalError] = useState<string | null>(null);

  /* Revoking is a security action, so it must never fail quietly: a request
     that 403s or never lands has to say so, otherwise the row stays on screen
     and reads as "still signed in" when we simply don't know. Both handlers
     also need their own catch — an unguarded reject escapes the click handler
     as an unhandled rejection rather than reaching the user. */
  async function revokeSession(sessionId: string) {
    setRevoking(sessionId);
    setRevokeError(null);
    try {
      const res = await fetch(`/api/dashboard/sessions/${sessionId}/revoke`, {
        method: "POST",
      });
      if (!res.ok) {
        setRevokeError("Couldn't sign that device out. Please try again.");
        return;
      }
      setSessions((prev) => prev.filter((s) => s.id !== sessionId));
    } catch {
      setRevokeError("Network error. Please try again.");
    } finally {
      setRevoking(null);
    }
  }

  async function revokeAllSessions() {
    setRevokingAll(true);
    setRevokeError(null);
    try {
      const res = await fetch("/api/dashboard/sessions/revoke-all", {
        method: "POST",
      });
      if (!res.ok) {
        setRevokeError("Couldn't revoke every session. Please try again.");
        return;
      }
      setSessions([]);
      /* Only dismiss the confirmation once it actually worked. Closing it on
         failure would drop the user back to the idle state and imply the
         devices were signed out, forcing them to re-confirm to find out. */
      setConfirmingRevokeAll(false);
    } catch {
      setRevokeError("Network error. Please try again.");
    } finally {
      setRevokingAll(false);
    }
  }

  async function openBillingPortal() {
    setPortalLoading(true);
    setPortalError(null);
    try {
      const res = await fetch("/api/billing/portal", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setPortalError(data.error ?? "Failed to open billing portal");
        return;
      }
      window.location.href = data.url;
    } catch {
      setPortalError("Network error. Please try again.");
    } finally {
      setPortalLoading(false);
    }
  }

  const isPaidPlan = plan === "pro" || plan === "team" || plan === "enterprise";

  /* Chip, meters and notification all read from one status object, so they can
     never disagree about how much trouble the org is in. */
  const alert = usageAlert(usage);
  const tone = TONE[usage.level];

  /* Dismissal is scoped to level + period: clearing "running low" must not
     also silence the later "almost out", and it all resets next period.
     Keyed on periodStart rather than currentPeriodEnd because free orgs have
     no Stripe period — a null there collapsed to one constant string, so a
     single dismissal silenced that level permanently. */
  const alertKey = `sanad:usage-alert:${usage.level}:${periodStart}`;
  const [alertDismissed, setAlertDismissed] = useState(true);

  /* Read after mount — localStorage does not exist during SSR and reading it
     inline would desync hydration. Starts hidden to avoid a flash. */
  useEffect(() => {
    setAlertDismissed(window.localStorage.getItem(alertKey) === "1");
  }, [alertKey]);

  function dismissAlert() {
    window.localStorage.setItem(alertKey, "1");
    setAlertDismissed(true);
  }

  return (
    <div style={s.root}>
      <Nav
        links={[
          { href: "/terminal", label: "Workspace", badge: "beta" },
          { href: "/pricing", label: "Pricing", compactHidden: true },
        ]}
        planBadge={plan}
      />

      <main className="pad-x" style={s.main}>
        <header style={s.header}>
          <h1 style={s.h1}>{orgName}</h1>
          <p style={s.sub}>
            <span style={s.planWord}>{plan}</span> plan
            {currentPeriodEnd && (
              <>
                <span style={s.dot}>·</span>
                renews {new Date(currentPeriodEnd).toLocaleDateString()}
              </>
            )}
            {plan === "team" && (
              <>
                <span style={s.dot}>·</span>
                <Link href="/dashboard/team" className="link">
                  Manage team
                </Link>
              </>
            )}
            <span style={s.dot}>·</span>
            {isPaidPlan && hasStripeCustomer ? (
              <button
                style={{ ...button.quiet(), ...disabled(portalLoading) }}
                onClick={openBillingPortal}
                disabled={portalLoading}
              >
                {portalLoading ? "Loading…" : "Manage billing"}
              </button>
            ) : (
              <Link href="/pricing" className="link">
                Upgrade
              </Link>
            )}
          </p>
          {portalError && (
            <div style={{ ...state.errorPanel, marginTop: "1rem" }}>
              <AlertTriangleIcon size={16} />
              <span>{portalError}</span>
            </div>
          )}
        </header>

        {/* Usage notification — appears once the balance crosses a threshold. */}
        {alert && !alertDismissed && (
          <div
            role="status"
            aria-live="polite"
            style={{
              ...s.alertBanner,
              borderColor: tone.ink,
              background: tone.wash,
            }}
          >
            <span style={{ color: tone.ink, display: "flex", flexShrink: 0 }}>
              <AlertTriangleIcon size={18} />
            </span>
            <div style={s.alertBody}>
              <strong style={{ ...s.alertTitle, color: tone.ink }}>
                {alert.title}
              </strong>
              <span style={s.alertText}>{alert.body}</span>
            </div>
            <div style={s.alertActions}>
              {!isPaidPlan && (
                <Link
                  href="/pricing"
                  style={{ ...button.primary(size.sm), textDecoration: "none" }}
                >
                  Upgrade
                </Link>
              )}
              <button
                type="button"
                onClick={dismissAlert}
                aria-label="Dismiss notification"
                style={s.alertDismiss}
              >
                <CrossOutlineIcon size={16} />
              </button>
            </div>
          </div>
        )}

        {/* Usage */}
        <section style={s.section}>
          <div style={s.sectionHead}>
            <h2 style={s.sectionTitle}>Usage this period</h2>
            <span
              style={{
                ...s.levelChip,
                color: tone.ink,
                background: tone.wash,
                borderColor: tone.ink,
              }}
            >
              {usage.level === "ok" ? (
                <CheckSolidIcon size={14} knockout={"var(--ok-wash)"} />
              ) : (
                <AlertTriangleIcon size={14} />
              )}
              {USAGE_LEVEL_LABEL[usage.level]}
            </span>
          </div>

          {/* Both caps are enforced, so both are shown, each with its own
              colour — an org can sit comfortably on requests while its token
              allowance is nearly gone, and only showing one would hide that. */}
          <Meter label="Requests" noun="requests" d={usage.requests} />
          <Meter label="Tokens" noun="tokens" d={usage.tokens} />

          {usageByModel.length === 0 ? (
            <p style={s.empty}>
              No usage yet — run{" "}
              <code style={s.inlineCode}>sanad run &quot;…&quot;</code> to start.
            </p>
          ) : (
            <table style={s.table}>
              <thead>
                <tr>
                  <th style={s.th}>Model</th>
                  <th style={{ ...s.th, textAlign: "right" }}>Requests</th>
                  <th style={{ ...s.th, textAlign: "right" }}>Tokens in</th>
                  <th style={{ ...s.th, textAlign: "right" }}>Tokens out</th>
                </tr>
              </thead>
              <tbody>
                {usageByModel.map((row) => (
                  <tr key={row.alias}>
                    <td style={s.td}>
                      <code style={s.model}>{row.alias}</code>
                    </td>
                    <td style={{ ...s.td, textAlign: "right" }}>
                      {row.requests.toLocaleString()}
                    </td>
                    <td style={{ ...s.td, textAlign: "right" }}>
                      {row.tokensIn.toLocaleString()}
                    </td>
                    <td style={{ ...s.td, textAlign: "right" }}>
                      {row.tokensOut.toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        {/* CLI Sessions */}
        <section style={s.section}>
          <div className="row-stack" style={s.sectionHead}>
            <h2 style={s.sectionTitle}>Active CLI sessions</h2>
            {sessions.length > 0 &&
              (confirmingRevokeAll ? (
                <div style={state.confirmPanel}>
                  <span style={s.confirmText}>Sign out of all devices?</span>
                  <button
                    style={{
                      ...button.dangerConfirm(size.sm),
                      ...disabled(revokingAll),
                    }}
                    onClick={revokeAllSessions}
                    disabled={revokingAll}
                  >
                    {revokingAll ? "Signing out…" : "Yes, revoke all"}
                  </button>
                  <button
                    style={{
                      ...button.quiet(),
                      ...disabled(revokingAll),
                      marginRight: "0.5rem",
                    }}
                    onClick={() => setConfirmingRevokeAll(false)}
                    disabled={revokingAll}
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  style={button.danger(size.sm)}
                  onClick={() => setConfirmingRevokeAll(true)}
                >
                  <PowerIcon size={14} strokeWidth={2} />
                  Revoke all sessions
                </button>
              ))}
          </div>

          {revokeError && (
            <div style={{ ...state.errorPanel, marginBottom: "1.25rem" }}>
              <AlertTriangleIcon size={16} />
              <span>{revokeError}</span>
            </div>
          )}

          {sessions.length === 0 ? (
            <div style={s.emptyCard}>
              <p style={{ margin: 0, color: "var(--ink-soft)" }}>
                No active CLI sessions.
              </p>
              <p style={s.hint}>
                Run <code style={s.inlineCode}>sanad login</code> in your
                terminal to connect.
              </p>
            </div>
          ) : (
            <div style={s.sessionList}>
              {sessions.map((session) => (
                <div key={session.id} className="row-stack" style={s.sessionRow}>
                  <div style={s.sessionInfo}>
                    <span style={s.sessionLabel}>{session.deviceLabel}</span>
                    <span style={s.sessionMeta}>
                      Created {new Date(session.createdAt).toLocaleDateString()}
                      {session.lastUsedAt &&
                        ` · Last used ${new Date(session.lastUsedAt).toLocaleDateString()}`}
                    </span>
                  </div>
                  <button
                    style={{
                      ...button.danger(size.sm),
                      ...disabled(revoking === session.id),
                    }}
                    onClick={() => revokeSession(session.id)}
                    disabled={revoking === session.id}
                  >
                    <PowerIcon size={14} strokeWidth={2} />
                    {revoking === session.id ? "Signing out…" : "Sign out"}
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

/**
 * One metered dimension: how much is left, how much of the cap is spent, and a
 * bar. Colour, hatching and the aria-label all move together, so the state
 * survives greyscale, colour-blindness and screen readers alike.
 */
function Meter({
  label,
  noun,
  d,
}: {
  label: string;
  noun: string;
  d: DimensionStatus;
}) {
  const tone = TONE[d.level];
  return (
    <div style={s.meter}>
      <span style={s.meterLabel}>{label}</span>
      <div style={s.usageHeader}>
        <span style={{ ...s.usageNum, color: tone.ink }}>
          {d.remaining.toLocaleString()}
          <span style={s.usageOf}> {noun} remaining</span>
        </span>
        <span style={s.usagePct}>
          {d.used.toLocaleString()} / {d.limit.toLocaleString()} used ·{" "}
          {d.usedPct}%
        </span>
      </div>
      <div
        style={{
          ...s.bar,
          borderColor: d.level === "ok" ? "var(--rule-strong)" : tone.ink,
          borderWidth: d.level === "ok" ? "1px" : "1.5px",
        }}
        role="img"
        aria-label={`${d.remainingPct}% of the ${noun} allowance remaining — ${USAGE_LEVEL_LABEL[d.level]}`}
      >
        <div
          style={{
            ...s.barFill,
            width: `${d.usedPct}%`,
            /* Hatching at "warning" keeps the levels apart in greyscale, so
               hue is reinforcement rather than the message itself. */
            ...(d.level === "warning"
              ? {
                  backgroundImage: `repeating-linear-gradient(45deg, ${tone.ink} 0 4px, ${tone.wash} 4px 8px)`,
                }
              : { background: tone.ink }),
          }}
        />
      </div>
    </div>
  );
}

const s: Record<string, CSSProperties> = {
  root: surface.page,
  main: {
    maxWidth: "880px",
    margin: "0 auto",
    padding: "3.5rem 2.5rem 5rem",
    width: "100%",
  },
  header: { marginBottom: "3.5rem" },
  h1: { ...type.h1, marginBottom: "0.5rem" },
  sub: {
    margin: 0,
    color: "var(--ink-muted)",
    fontSize: "0.875rem",
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
  },
  planWord: {
    fontFamily: "var(--font-mono)",
    textTransform: "uppercase",
    letterSpacing: "0.1em",
    fontSize: "0.75rem",
    color: "var(--ink)",
    marginRight: "0.4rem",
  },
  dot: { margin: "0 0.55rem", color: "var(--rule-strong)" },
  section: {
    marginBottom: "3.5rem",
  },
  sectionHead: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "1rem",
    paddingBottom: "0.9rem",
    marginBottom: "1.5rem",
    borderBottom: "1px solid var(--rule)",
  },
  sectionTitle: { ...type.eyebrow },
  /* Status chip — hue plus an icon plus a word, so no single channel carries
     the meaning on its own. Colours are applied per level at the call site. */
  levelChip: {
    display: "inline-flex",
    alignItems: "center",
    gap: "0.4rem",
    borderStyle: "solid",
    borderWidth: "1.5px",
    borderRadius: "var(--radius-pill)",
    padding: "0.15rem 0.7rem",
    fontSize: "0.72rem",
    fontWeight: 700,
    letterSpacing: "0.04em",
    textTransform: "uppercase",
    whiteSpace: "nowrap",
  },
  alertBanner: {
    display: "flex",
    alignItems: "flex-start",
    gap: "0.85rem",
    borderStyle: "solid",
    borderWidth: "1.5px",
    borderRadius: "var(--radius-md)",
    padding: "1rem 1.1rem",
    marginBottom: "2.5rem",
  },
  alertBody: {
    display: "flex",
    flexDirection: "column",
    gap: "0.2rem",
    flex: 1,
    minWidth: 0,
  },
  alertTitle: { fontSize: "0.9rem", fontWeight: 700, letterSpacing: "-0.01em" },
  alertText: { fontSize: "0.83rem", color: "var(--ink-soft)", lineHeight: 1.5 },
  alertActions: {
    display: "flex",
    alignItems: "center",
    gap: "0.6rem",
    flexShrink: 0,
  },
  alertDismiss: {
    background: "none",
    border: "none",
    padding: "0.2rem",
    cursor: "pointer",
    color: "var(--ink-muted)",
    display: "flex",
  },
  usageHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "baseline",
    gap: "1rem",
    marginBottom: "0.85rem",
  },
  usageNum: {
    fontSize: "1.75rem",
    fontWeight: 700,
    letterSpacing: "-0.03em",
    color: "var(--ink)",
  },
  usageOf: { fontSize: "0.875rem", fontWeight: 400, color: "var(--ink-muted)" },
  usagePct: {
    fontFamily: "var(--font-mono)",
    color: "var(--ink-soft)",
    fontSize: "0.875rem",
  },
  meter: { marginBottom: "1.9rem" },
  meterLabel: {
    display: "block",
    fontFamily: "var(--font-mono)",
    fontSize: "0.68rem",
    textTransform: "uppercase",
    letterSpacing: "0.12em",
    color: "var(--ink-muted)",
    marginBottom: "0.55rem",
  },
  bar: {
    height: "12px",
    background: "var(--paper-sunken)",
    border: "1px solid var(--rule-strong)",
    borderRadius: "var(--radius-pill)",
    overflow: "hidden",
  },
  barFill: {
    height: "100%",
    borderRadius: "var(--radius-pill)",
    transition: "width 0.6s ease",
  },
  empty: { ...type.small, color: "var(--ink-muted)" },
  inlineCode: {
    fontFamily: "var(--font-mono)",
    fontSize: "0.85em",
    background: "var(--paper-sunken)",
    border: "1px solid var(--rule)",
    borderRadius: "5px",
    padding: "0.05rem 0.35rem",
    color: "var(--ink)",
  },
  table: { width: "100%", borderCollapse: "collapse" },
  th: {
    padding: "0 0.25rem 0.5rem",
    fontFamily: "var(--font-mono)",
    fontSize: "0.68rem",
    textTransform: "uppercase",
    letterSpacing: "0.12em",
    color: "var(--ink-muted)",
    fontWeight: 500,
    textAlign: "left",
    borderBottom: "1px solid var(--rule)",
  },
  td: {
    padding: "0.7rem 0.25rem",
    fontSize: "0.875rem",
    color: "var(--ink-soft)",
    borderBottom: "1px solid var(--rule)",
  },
  model: { fontFamily: "var(--font-mono)", fontSize: "0.8rem", color: "var(--ink)" },
  sessionList: { borderTop: "1px solid var(--rule)" },
  sessionRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "1rem",
    padding: "1.1rem 0.25rem",
    borderBottom: "1px solid var(--rule)",
  },
  sessionInfo: { display: "flex", flexDirection: "column", gap: "0.15rem" },
  sessionLabel: { fontWeight: 600, fontSize: "0.9rem", color: "var(--ink)" },
  sessionMeta: { color: "var(--ink-muted)", fontSize: "0.78rem" },
  confirmText: { color: "var(--ink)", fontSize: "0.8rem", fontWeight: 600 },
  emptyCard: {
    border: "1px dashed var(--rule-strong)",
    borderRadius: "var(--radius-lg)",
    padding: "2.5rem",
    textAlign: "center",
  },
  hint: { margin: "0.4rem 0 0", color: "var(--ink-muted)", fontSize: "0.85rem" },
};
