"use client";

import { useCallback, useEffect, useState } from "react";
import type { CSSProperties } from "react";
import type { DimensionStatus, UsageLevel } from "@/lib/billing/usage";

interface Summary {
  plan: string;
  level: UsageLevel;
  isExceeded: boolean;
  requests: DimensionStatus;
  tokens: DimensionStatus;
  periodEnd: string | null;
}

const POLL_MS = 60_000;

/* Non-"ok" states get a short word so the meter reads in greyscale — the bar
   fill alone never carries the message (matches the dashboard meter). */
const LEVEL_NOTE: Record<UsageLevel, string | null> = {
  ok: null,
  warning: "Running low",
  critical: "Almost out",
  exceeded: "Limit reached",
};

/**
 * The workspace usage dock (US-001..006): a compact month-to-date meter parked
 * at the foot of the file sidebar, where the agent is actively spending the
 * allowance. Reads the Clerk-authed /api/usage/summary — a pure control-plane
 * aggregate, so polling it never wakes or touches the session machine.
 */
export default function UsageDock() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/usage/summary");
      if (!res.ok) {
        setFailed(true);
        return;
      }
      const body = await res.json();
      if (body?.data) {
        setSummary(body.data as Summary);
        setFailed(false);
      }
    } catch {
      /* transient — the next tick retries */
    }
  }, []);

  useEffect(() => {
    void load();
    const tick = () => {
      if (document.visibilityState === "visible") void load();
    };
    const timer = window.setInterval(tick, POLL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [load]);

  // If usage can't be read at all, stay silent rather than showing a broken
  // dock — the file tree above is the sidebar's primary job.
  if (failed && !summary) return null;

  return (
    <div style={s.dock}>
      <div style={s.head}>
        <span style={s.title}>Usage · this month</span>
        <a href="/usage" style={s.link}>
          Details
        </a>
      </div>
      {summary ? (
        <>
          <CompactMeter label="Requests" d={summary.requests} />
          <CompactMeter label="Tokens" d={summary.tokens} />
        </>
      ) : (
        <div style={s.loading}>Loading…</div>
      )}
    </div>
  );
}

function CompactMeter({ label, d }: { label: string; d: DimensionStatus }) {
  const note = LEVEL_NOTE[d.level];
  return (
    <div style={s.meter}>
      <div style={s.meterTop}>
        <span style={s.meterLabel}>{label}</span>
        <span style={s.meterVal}>
          {d.used.toLocaleString()} / {d.limit.toLocaleString()}
        </span>
      </div>
      <div
        style={s.bar}
        role="img"
        aria-label={`${label}: ${d.remainingPct}% of the allowance remaining${
          note ? ` — ${note}` : ""
        }`}
      >
        <div
          style={{
            ...s.barFill,
            width: `${d.usedPct}%`,
            /* Hatch once the allowance is genuinely gone, so "exceeded" is
               distinct from a merely-full bar without relying on colour. */
            ...(d.level === "exceeded"
              ? {
                  backgroundImage:
                    "repeating-linear-gradient(45deg, var(--ink) 0 3px, var(--paper) 3px 6px)",
                }
              : { background: "var(--ink)" }),
          }}
        />
      </div>
      {note && <span style={s.note}>{note}</span>}
    </div>
  );
}

const s: Record<string, CSSProperties> = {
  dock: {
    borderTop: "1px solid var(--rule)",
    padding: "0.6rem 0.75rem 0.7rem",
    display: "flex",
    flexDirection: "column",
    gap: "0.5rem",
    background: "var(--paper)",
  },
  head: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
  },
  title: {
    fontFamily: "var(--font-mono)",
    fontSize: "0.6rem",
    fontWeight: 600,
    letterSpacing: "0.1em",
    textTransform: "uppercase",
    color: "var(--ink-muted)",
  },
  link: {
    fontSize: "0.68rem",
    color: "var(--ink-muted)",
    textDecoration: "none",
  },
  loading: { fontSize: "0.72rem", color: "var(--ink-muted)" },
  meter: { display: "flex", flexDirection: "column", gap: "0.2rem" },
  meterTop: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: "0.5rem",
  },
  meterLabel: { fontSize: "0.72rem", color: "var(--ink-soft)" },
  meterVal: {
    fontFamily: "var(--font-mono)",
    fontSize: "0.66rem",
    color: "var(--ink-muted)",
    whiteSpace: "nowrap",
  },
  bar: {
    height: "5px",
    borderRadius: "999px",
    background: "var(--rule)",
    overflow: "hidden",
  },
  barFill: { height: "100%", borderRadius: "999px" },
  note: {
    fontSize: "0.64rem",
    fontWeight: 600,
    color: "var(--ink-soft)",
  },
};
