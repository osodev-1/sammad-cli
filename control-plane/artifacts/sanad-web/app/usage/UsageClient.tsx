"use client";

import { useState } from "react";
import type { CSSProperties } from "react";
import Nav from "../ui/Nav";
import type { DimensionStatus, UsageStatus } from "@/lib/billing/usage";
import type { UsageDay } from "@/lib/billing/usage-series";

const NAV_LINKS = [
  { href: "/terminal", label: "Workspace", badge: "beta" },
  { href: "/pricing", label: "Pricing" },
  { href: "/dashboard", label: "Dashboard" },
  { href: "/usage", label: "Usage" },
];

type Metric = "tokens" | "requests";

export default function UsageClient({
  orgName,
  plan,
  usage,
  periodEnd,
  byModel,
  series,
}: {
  orgName: string;
  plan: string;
  usage: UsageStatus;
  periodEnd: string | null;
  byModel: {
    alias: string;
    requests: number;
    tokensIn: number;
    tokensOut: number;
  }[];
  series: UsageDay[];
}) {
  const [metric, setMetric] = useState<Metric>("tokens");
  const value = (d: UsageDay) =>
    metric === "tokens" ? d.tokensIn + d.tokensOut : d.requests;
  const max = Math.max(1, ...series.map(value));
  const total = series.reduce((a, d) => a + value(d), 0);

  return (
    <>
      <Nav links={NAV_LINKS} />
      <main className="pad-x" style={s.main}>
        <header style={s.header}>
          <div>
            <p style={s.eyebrow}>Usage · {orgName}</p>
            <h1 style={s.h1}>Usage</h1>
          </div>
          <div style={s.periodChip}>
            <span style={s.plan}>{plan}</span>
            {periodEnd && (
              <span>renews {new Date(periodEnd).toLocaleDateString()}</span>
            )}
          </div>
        </header>

        <section style={s.meters}>
          <Meter label="Requests" noun="requests" d={usage.requests} />
          <Meter label="Tokens" noun="tokens" d={usage.tokens} />
        </section>

        <section style={s.card}>
          <div style={s.cardHead}>
            <div>
              <h2 style={s.h2}>Last 30 days</h2>
              <p style={s.sub}>
                {total.toLocaleString()} {metric} in the window
              </p>
            </div>
            <div style={s.toggle}>
              {(["tokens", "requests"] as const).map((m) => (
                <button
                  key={m}
                  style={{
                    ...s.toggleBtn,
                    ...(metric === m ? s.toggleActive : null),
                  }}
                  onClick={() => setMetric(m)}
                >
                  {m}
                </button>
              ))}
            </div>
          </div>
          <div style={s.chart}>
            {series.map((d) => (
              <div
                key={d.day}
                style={s.barCol}
                title={`${d.day}: ${value(d).toLocaleString()} ${metric}`}
              >
                <div style={s.barTrack}>
                  <div
                    style={{ ...s.bar, height: `${(value(d) / max) * 100}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
          <div style={s.axis}>
            <span>{series[0]?.day.slice(5)}</span>
            <span>peak {max.toLocaleString()}</span>
            <span>{series[series.length - 1]?.day.slice(5)}</span>
          </div>
        </section>

        <section style={s.card}>
          <h2 style={s.h2}>By model</h2>
          {byModel.length === 0 ? (
            <p style={s.sub}>No usage yet this period.</p>
          ) : (
            <div style={s.tableWrap}>
              <table style={s.table}>
                <thead>
                  <tr>
                    <th style={s.th}>Model</th>
                    <th style={{ ...s.th, ...s.num }}>Requests</th>
                    <th style={{ ...s.th, ...s.num }}>Tokens in</th>
                    <th style={{ ...s.th, ...s.num }}>Tokens out</th>
                  </tr>
                </thead>
                <tbody>
                  {byModel
                    .slice()
                    .sort(
                      (a, b) =>
                        b.tokensIn + b.tokensOut - (a.tokensIn + a.tokensOut),
                    )
                    .map((r) => (
                      <tr key={r.alias}>
                        <td style={s.td}>{r.alias}</td>
                        <td style={{ ...s.td, ...s.num }}>
                          {r.requests.toLocaleString()}
                        </td>
                        <td style={{ ...s.td, ...s.num }}>
                          {r.tokensIn.toLocaleString()}
                        </td>
                        <td style={{ ...s.td, ...s.num }}>
                          {r.tokensOut.toLocaleString()}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>
    </>
  );
}

function Meter({
  label,
  noun,
  d,
}: {
  label: string;
  noun: string;
  d: DimensionStatus;
}) {
  const alert = d.level !== "ok";
  return (
    <div style={s.meter}>
      <div style={s.meterHead}>
        <span style={s.meterLabel}>{label}</span>
        <span style={s.meterPct}>
          {d.used.toLocaleString()} / {d.limit.toLocaleString()} · {d.usedPct}%
        </span>
      </div>
      <div
        style={{
          ...s.meterTrack,
          borderColor: alert ? "var(--ink)" : "var(--rule-strong)",
        }}
        role="img"
        aria-label={`${d.remainingPct}% of the ${noun} allowance remaining`}
      >
        <div
          style={{
            ...s.meterFill,
            width: `${d.usedPct}%`,
            ...(d.level === "warning"
              ? {
                  backgroundImage:
                    "repeating-linear-gradient(45deg, var(--ink) 0 4px, var(--paper-sunken) 4px 8px)",
                }
              : { background: "var(--ink)" }),
          }}
        />
      </div>
      <span style={s.meterRemain}>
        {d.remaining.toLocaleString()} remaining
      </span>
    </div>
  );
}

const s: Record<string, CSSProperties> = {
  main: {
    maxWidth: "72rem",
    margin: "0 auto",
    padding: "1.5rem 0 4rem",
    display: "flex",
    flexDirection: "column",
    gap: "1.25rem",
  },
  header: {
    display: "flex",
    alignItems: "flex-end",
    justifyContent: "space-between",
    gap: "1rem",
    flexWrap: "wrap",
  },
  eyebrow: {
    fontFamily: "var(--font-mono)",
    fontSize: "0.7rem",
    letterSpacing: "0.1em",
    textTransform: "uppercase",
    color: "var(--ink-muted)",
  },
  h1: {
    fontSize: "1.8rem",
    fontWeight: 650,
    color: "var(--ink)",
    margin: "0.1rem 0 0",
  },
  periodChip: {
    display: "inline-flex",
    alignItems: "center",
    gap: "0.6rem",
    fontSize: "0.8rem",
    color: "var(--ink-muted)",
  },
  plan: {
    fontFamily: "var(--font-mono)",
    fontSize: "0.68rem",
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    border: "1px solid var(--rule-strong)",
    borderRadius: "var(--radius-pill)",
    padding: "0.1rem 0.6rem",
    color: "var(--ink)",
  },
  meters: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
    gap: "1rem",
  },
  meter: {
    border: "1px solid var(--rule)",
    borderRadius: "var(--radius-lg)",
    padding: "0.9rem 1rem",
    background: "var(--paper)",
    display: "flex",
    flexDirection: "column",
    gap: "0.45rem",
  },
  meterHead: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: "0.5rem",
  },
  meterLabel: { fontSize: "0.82rem", fontWeight: 600, color: "var(--ink)" },
  meterPct: {
    fontFamily: "var(--font-mono)",
    fontSize: "0.72rem",
    color: "var(--ink-muted)",
  },
  meterTrack: {
    height: "8px",
    borderRadius: "var(--radius-pill)",
    border: "1px solid var(--rule-strong)",
    overflow: "hidden",
    background: "var(--paper-sunken)",
  },
  meterFill: { height: "100%" },
  meterRemain: { fontSize: "0.74rem", color: "var(--ink-soft)" },
  card: {
    border: "1px solid var(--rule)",
    borderRadius: "var(--radius-lg)",
    padding: "1.1rem 1.2rem",
    background: "var(--paper)",
    display: "flex",
    flexDirection: "column",
    gap: "0.8rem",
  },
  cardHead: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: "1rem",
  },
  h2: { fontSize: "1rem", fontWeight: 620, color: "var(--ink)", margin: 0 },
  sub: { fontSize: "0.8rem", color: "var(--ink-muted)", margin: "0.15rem 0 0" },
  toggle: { display: "inline-flex", gap: "2px" },
  toggleBtn: {
    font: "inherit",
    fontSize: "0.72rem",
    textTransform: "capitalize",
    color: "var(--ink-muted)",
    background: "none",
    border: "1px solid var(--rule-strong)",
    borderRadius: "var(--radius-pill)",
    padding: "0.15rem 0.7rem",
    cursor: "pointer",
  },
  toggleActive: {
    background: "var(--ink)",
    color: "var(--paper)",
    borderColor: "var(--ink)",
  },
  chart: {
    display: "flex",
    alignItems: "flex-end",
    gap: "3px",
    height: "140px",
  },
  barCol: {
    flex: 1,
    minWidth: 0,
    height: "100%",
    display: "flex",
    alignItems: "flex-end",
  },
  barTrack: {
    width: "100%",
    height: "100%",
    display: "flex",
    alignItems: "flex-end",
  },
  bar: {
    width: "100%",
    minHeight: "1px",
    background: "var(--ink)",
    borderRadius: "2px 2px 0 0",
  },
  axis: {
    display: "flex",
    justifyContent: "space-between",
    fontFamily: "var(--font-mono)",
    fontSize: "0.66rem",
    color: "var(--ink-muted)",
  },
  tableWrap: { overflowX: "auto" },
  table: { width: "100%", borderCollapse: "collapse", fontSize: "0.82rem" },
  th: {
    textAlign: "left",
    padding: "0.4rem 0.6rem",
    borderBottom: "1px solid var(--rule-strong)",
    color: "var(--ink-muted)",
    fontWeight: 600,
    fontSize: "0.72rem",
    textTransform: "uppercase",
    letterSpacing: "0.04em",
  },
  td: {
    padding: "0.4rem 0.6rem",
    borderBottom: "1px solid var(--rule)",
    color: "var(--ink)",
    fontFamily: "var(--font-mono)",
  },
  num: { textAlign: "right", fontVariantNumeric: "tabular-nums" },
};
