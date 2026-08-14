"use client";

import { useCallback, useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { reviewTrust } from "@/lib/blueprint/api";
import { withSession } from "@/lib/terminal/workspace-model";

interface TrustItem {
  path: string;
  status: "trusted" | "untrusted" | "changed" | "tampered";
}

interface Commit {
  hash: string;
  authorName: string;
  date: string;
  subject: string;
}

const POLL_MS = 30_000;

/**
 * The contextual right dock (R4) — replaces the fixed Projects pane. Content
 * follows the page state: on the Blueprint tab it is the work queue (pending
 * reviews, the trust queue, the git-backed history timeline); on any other
 * tab it is a compact activity feed with a jump back to the Blueprint. The
 * toggle carries a badge whenever reviews or trust items await the user.
 *
 * Data discipline: trust + history are CONTROL-PLANE-PROXIED machine reads,
 * fetched only while the dock is open and the page visible, on a slow poll —
 * plus an immediate refetch whenever `activityEpoch` bumps (an apply/revert
 * just happened). The dock never wakes a sleeping machine on its own: fetch
 * failures render as quiet empty states, and the poll backs off nothing —
 * the snapshot poll's liveness already gates the workspace experience.
 */
export default function ContextDock({
  sessionId,
  context,
  open,
  onToggle,
  pendingReviews,
  activityEpoch,
  onOpenGraph,
}: {
  sessionId?: string;
  /** "graph" when the Blueprint tab is active; anything else is "other". */
  context: "graph" | "other";
  open: boolean;
  onToggle: () => void;
  /** Architect drafts awaiting review (summaries, newest last). */
  pendingReviews: string[];
  /** Bumped after applies/reverts — triggers an immediate refetch. */
  activityEpoch: number;
  onOpenGraph: () => void;
}) {
  const [trust, setTrust] = useState<TrustItem[]>([]);
  const [commits, setCommits] = useState<Commit[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [diff, setDiff] = useState<string | null>(null);
  const [trustBusy, setTrustBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [trustRes, logRes] = await Promise.all([
        fetch(withSession("/api/blueprint/trust", sessionId)),
        fetch(withSession("/api/git/log?path=.sanad&limit=30", sessionId)),
      ]);
      if (trustRes.ok) {
        const body = await trustRes.json();
        const entries = body?.data?.entries ?? body?.entries ?? {};
        const items: TrustItem[] = Object.entries(entries)
          .map(([path, v]) => ({
            path,
            status: (v as { status?: TrustItem["status"] }).status ?? "trusted",
          }))
          .filter((t) => t.status !== "trusted");
        setTrust(items);
      }
      if (logRes.ok) {
        const body = await logRes.json();
        setCommits(body?.data?.commits ?? []);
      }
    } catch {
      /* machine asleep or offline — quiet empty states */
    }
  }, [sessionId]);

  useEffect(() => {
    if (!open) return;
    void load();
    const tick = () => {
      if (document.visibilityState === "visible") void load();
    };
    const timer = window.setInterval(tick, POLL_MS);
    return () => window.clearInterval(timer);
  }, [open, load, activityEpoch]);

  const toggleCommit = useCallback(
    async (hash: string) => {
      if (expanded === hash) {
        setExpanded(null);
        setDiff(null);
        return;
      }
      setExpanded(hash);
      setDiff(null);
      try {
        const res = await fetch(
          withSession(
            `/api/git/show?ref=${encodeURIComponent(hash)}&path=.sanad`,
            sessionId,
          ),
        );
        if (res.ok) {
          const body = await res.json();
          setDiff(body?.data?.diff ?? "(no diff)");
        } else {
          setDiff("(could not load the diff)");
        }
      } catch {
        setDiff("(could not load the diff)");
      }
    },
    [expanded, sessionId],
  );

  const doTrust = useCallback(
    async (path: string) => {
      setTrustBusy(path);
      const res = await reviewTrust(path, sessionId);
      setTrustBusy(null);
      if (res.ok) void load();
    },
    [sessionId, load],
  );

  const badge = pendingReviews.length + trust.length;

  if (!open) {
    return (
      <aside style={s.rail}>
        <button
          type="button"
          style={s.railButton}
          onClick={onToggle}
          title="Show reviews, trust and history"
          aria-label="Show the context dock"
        >
          ◧
        </button>
        {badge > 0 && <span style={s.railBadge}>{badge}</span>}
      </aside>
    );
  }

  return (
    <aside style={s.pane}>
      <div style={s.header}>
        <span style={s.title}>
          {context === "graph" ? "Blueprint" : "Activity"}
        </span>
        <button
          type="button"
          style={s.railButton}
          onClick={onToggle}
          title="Hide"
          aria-label="Hide the context dock"
        >
          ✕
        </button>
      </div>

      <div style={s.scroll}>
        {/* Reviews — architect drafts awaiting the user, wherever they are. */}
        <Section
          title={`Reviews${pendingReviews.length ? ` · ${pendingReviews.length}` : ""}`}
        >
          {pendingReviews.length === 0 ? (
            <span style={s.emptyLine}>Nothing waiting on you.</span>
          ) : (
            pendingReviews.map((summary, i) => (
              <button key={i} style={s.itemLink} onClick={onOpenGraph}>
                {summary}
              </button>
            ))
          )}
        </Section>

        {/* Trust queue — executable definitions not yet reviewed. */}
        <Section title={`Trust${trust.length ? ` · ${trust.length}` : ""}`}>
          {trust.length === 0 ? (
            <span style={s.emptyLine}>Everything reviewed.</span>
          ) : (
            trust.map((t) => (
              <div key={t.path} style={s.trustRow}>
                <span style={s.trustPath} title={t.path}>
                  {t.path.replace(".sanad/", "")}
                  <span
                    style={
                      t.status === "tampered"
                        ? s.trustStateTampered
                        : s.trustState
                    }
                  >
                    {t.status === "tampered"
                      ? " tampered"
                      : t.status === "changed"
                        ? " changed"
                        : " unreviewed"}
                  </span>
                </span>
                <button
                  style={s.trustBtn}
                  disabled={trustBusy === t.path}
                  onClick={() => void doTrust(t.path)}
                >
                  {trustBusy === t.path ? "…" : "Trust"}
                </button>
              </div>
            ))
          )}
        </Section>

        {/* History — the git-backed blueprint timeline (R3). */}
        <Section title="History">
          {commits.length === 0 ? (
            <span style={s.emptyLine}>No blueprint commits yet.</span>
          ) : (
            commits.map((c) => (
              <div key={c.hash}>
                <button
                  style={s.commitRow}
                  onClick={() => void toggleCommit(c.hash)}
                >
                  <span style={s.commitSubject} title={c.subject}>
                    {c.subject}
                  </span>
                  <span style={s.commitMeta}>
                    {c.hash} · {new Date(c.date).toLocaleDateString()}
                  </span>
                </button>
                {expanded === c.hash && (
                  <pre style={s.diff}>{diff ?? "Loading…"}</pre>
                )}
              </div>
            ))
          )}
        </Section>
      </div>
    </aside>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div style={s.section}>
      <span style={s.sectionTitle}>{title}</span>
      {children}
    </div>
  );
}

const s: Record<string, CSSProperties> = {
  rail: {
    width: "34px",
    minWidth: "34px",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "0.3rem",
    paddingTop: "0.5rem",
    borderLeft: "1px solid var(--rule)",
    background: "var(--paper)",
  },
  railButton: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "26px",
    height: "26px",
    border: "none",
    background: "none",
    borderRadius: "var(--radius-sm)",
    color: "var(--ink-muted)",
    cursor: "pointer",
    fontSize: "0.85rem",
  },
  railBadge: {
    fontFamily: "var(--font-mono)",
    fontSize: "0.62rem",
    fontWeight: 700,
    color: "var(--paper)",
    background: "var(--ink)",
    borderRadius: "999px",
    minWidth: "16px",
    textAlign: "center",
    lineHeight: "16px",
    padding: "0 3px",
  },
  pane: {
    width: "252px",
    minWidth: "252px",
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
    borderLeft: "1px solid var(--rule)",
    background: "var(--paper)",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "0.55rem 0.75rem 0.3rem",
  },
  title: {
    fontFamily: "var(--font-mono)",
    fontSize: "0.66rem",
    fontWeight: 600,
    letterSpacing: "0.12em",
    textTransform: "uppercase",
    color: "var(--ink-muted)",
  },
  scroll: {
    flex: 1,
    minHeight: 0,
    overflowY: "auto",
    padding: "0 0.75rem 1rem",
  },
  section: {
    display: "flex",
    flexDirection: "column",
    gap: "0.35rem",
    marginTop: "0.9rem",
  },
  sectionTitle: {
    fontFamily: "var(--font-mono)",
    fontSize: "0.6rem",
    letterSpacing: "0.1em",
    textTransform: "uppercase",
    color: "var(--ink-muted)",
  },
  emptyLine: { fontSize: "0.75rem", color: "var(--ink-muted)" },
  itemLink: {
    textAlign: "left",
    font: "inherit",
    fontSize: "0.78rem",
    color: "var(--ink)",
    background: "var(--paper-sunken)",
    border: "1px solid var(--rule)",
    borderRadius: "var(--radius-sm)",
    padding: "0.3rem 0.5rem",
    cursor: "pointer",
  },
  trustRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "0.4rem",
  },
  trustPath: {
    fontFamily: "var(--font-mono)",
    fontSize: "0.68rem",
    color: "var(--ink-soft)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  trustState: { color: "var(--ink-muted)", fontStyle: "italic" },
  /* Most severe trust presentation: bold ink, no italic softening — the
     same escalation the graph badge and inspector note use. */
  trustStateTampered: { color: "var(--ink)", fontWeight: 700 },
  trustBtn: {
    font: "inherit",
    fontSize: "0.68rem",
    fontWeight: 600,
    color: "var(--ink)",
    background: "none",
    border: "1px solid var(--ink)",
    borderRadius: "var(--radius-pill)",
    padding: "0.1rem 0.5rem",
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  commitRow: {
    width: "100%",
    display: "flex",
    flexDirection: "column",
    gap: "1px",
    textAlign: "left",
    background: "none",
    border: "none",
    padding: "0.25rem 0",
    cursor: "pointer",
  },
  commitSubject: {
    fontSize: "0.75rem",
    color: "var(--ink)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  commitMeta: {
    fontFamily: "var(--font-mono)",
    fontSize: "0.62rem",
    color: "var(--ink-muted)",
  },
  diff: {
    margin: "0.2rem 0 0.4rem",
    padding: "0.4rem 0.5rem",
    background: "var(--paper-sunken)",
    border: "1px solid var(--rule)",
    borderRadius: "var(--radius-sm)",
    fontFamily: "var(--font-mono)",
    fontSize: "0.62rem",
    lineHeight: 1.45,
    color: "var(--ink-soft)",
    whiteSpace: "pre-wrap",
    overflowX: "auto",
    maxHeight: "220px",
    overflowY: "auto",
  },
};
