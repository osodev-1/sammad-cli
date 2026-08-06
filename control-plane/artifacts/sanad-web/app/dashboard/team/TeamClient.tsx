"use client";

import { useState } from "react";
import type { CSSProperties } from "react";
import Link from "next/link";
import Nav from "../../ui/Nav";
import {
  AlertTriangleIcon,
  ArrowLeftIcon,
  CheckSolidIcon,
  CrossOutlineIcon,
} from "../../ui/icons";
import {
  button,
  disabled,
  input,
  size,
  state,
  surface,
  type,
} from "../../ui/theme";

interface Member {
  membershipId: string;
  userId: string;
  role: string;
  seatAssigned: boolean;
  email: string;
  displayName: string | null;
}

interface Props {
  orgName: string;
  plan: string;
  isTeamPlan: boolean;
  isAdmin: boolean;
  seatLimit: number;
  currentUserId: string;
  members: Member[];
}

export default function TeamClient({
  orgName,
  plan,
  isTeamPlan,
  isAdmin,
  seatLimit,
  currentUserId,
  members: initialMembers,
}: Props) {
  const [members, setMembers] = useState(initialMembers);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviting, setInviting] = useState(false);
  const [inviteMsg, setInviteMsg] = useState<string | null>(null);

  const seatsUsed = members.filter((m) => m.seatAssigned).length;

  async function toggleSeat(member: Member) {
    setBusy(member.membershipId);
    setError(null);
    try {
      const res = await fetch("/api/team/seats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          membershipId: member.membershipId,
          assigned: !member.seatAssigned,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to update seat");
        return;
      }
      setMembers((prev) =>
        prev.map((m) =>
          m.membershipId === member.membershipId
            ? { ...m, seatAssigned: data.seatAssigned }
            : m
        )
      );
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setBusy(null);
    }
  }

  async function invite(e: React.FormEvent) {
    e.preventDefault();
    if (!inviteEmail.trim()) return;
    setInviting(true);
    setError(null);
    setInviteMsg(null);
    try {
      const res = await fetch("/api/team/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: inviteEmail.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to invite member");
        return;
      }
      setMembers((prev) => [
        ...prev,
        {
          membershipId: data.membershipId,
          userId: "",
          role: "member",
          seatAssigned: false,
          email: data.email,
          displayName: null,
        },
      ]);
      setInviteEmail("");
      setInviteMsg(`${data.email} added to the team (no seat yet).`);
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setInviting(false);
    }
  }

  return (
    <div style={s.root}>
      <Nav
        links={[
          { href: "/terminal", label: "Workspace", badge: "beta" },
          { href: "/dashboard", label: "Dashboard", compactHidden: true },
        ]}
        planBadge={plan}
      />

      <main className="pad-x" style={s.main}>
        <header style={s.header}>
          <Link href="/dashboard" style={s.breadcrumb}>
            <ArrowLeftIcon size={14} />
            Dashboard
          </Link>
          <h1 style={s.h1}>Team — {orgName}</h1>
          <p style={s.sub}>
            {isTeamPlan ? (
              <>
                <strong style={s.strong}>{seatsUsed}</strong> of{" "}
                <strong style={s.strong}>{seatLimit}</strong> seats assigned
              </>
            ) : (
              <>
                Seat management requires a Team plan.{" "}
                <Link href="/pricing" className="link">
                  Upgrade
                </Link>
              </>
            )}
          </p>
        </header>

        {error && (
          <div style={{ ...state.errorPanel, marginBottom: "1.75rem" }}>
            <AlertTriangleIcon size={16} />
            <span>{error}</span>
          </div>
        )}
        {inviteMsg && (
          <div style={s.okBanner}>
            <CheckSolidIcon size={16} />
            <span>{inviteMsg}</span>
          </div>
        )}

        {isTeamPlan && isAdmin && (
          <section style={s.section}>
            <h2 style={s.sectionTitle}>Invite a member</h2>
            <form onSubmit={invite} className="row-stack" style={s.inviteForm}>
              <input
                type="email"
                required
                placeholder="teammate@company.com"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                style={s.input}
              />
              <button
                type="submit"
                style={{ ...button.primary(size.md), ...disabled(inviting) }}
                disabled={inviting}
              >
                {inviting ? "Inviting…" : "Invite"}
              </button>
            </form>
            <p style={s.hint}>
              Invitees must already have a Sanad account. Assign them a seat
              below once added.
            </p>
          </section>
        )}

        <section style={s.section}>
          <h2 style={s.sectionTitle}>Members</h2>
          <div style={s.list}>
            {members.map((m) => (
              <div key={m.membershipId} className="row-stack" style={s.row}>
                <div style={s.info}>
                  <span style={s.name}>
                    {m.displayName ?? m.email}
                    {m.userId === currentUserId && (
                      <span style={s.you}> (you)</span>
                    )}
                  </span>
                  <span style={s.meta}>
                    {m.email} · {m.role}
                  </span>
                </div>
                <div style={s.rowRight}>
                  {/* Assigned = solid ink chip with a mark; unassigned = a
                      quiet hairline outline. Distinct by fill, not hue. */}
                  {m.seatAssigned ? (
                    <span style={s.seatOn}>
                      <CheckSolidIcon size={13} knockout="var(--ink)" />
                      Seat assigned
                    </span>
                  ) : (
                    <span style={state.neutralBadge}>No seat</span>
                  )}
                  {isTeamPlan && isAdmin && (
                    <button
                      style={{
                        ...(m.seatAssigned
                          ? button.danger(size.sm)
                          : button.secondary(size.sm)),
                        ...disabled(busy === m.membershipId),
                      }}
                      onClick={() => toggleSeat(m)}
                      disabled={busy === m.membershipId}
                    >
                      {busy === m.membershipId ? (
                        "Saving…"
                      ) : m.seatAssigned ? (
                        <>
                          <CrossOutlineIcon size={13} />
                          Revoke seat
                        </>
                      ) : (
                        "Assign seat"
                      )}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      </main>
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
  header: { marginBottom: "2.75rem" },
  breadcrumb: {
    display: "inline-flex",
    alignItems: "center",
    gap: "0.4rem",
    fontSize: "0.82rem",
    color: "var(--ink-muted)",
    marginBottom: "1rem",
  },
  h1: { ...type.h1, marginBottom: "0.5rem" },
  sub: { margin: 0, color: "var(--ink-muted)", fontSize: "0.875rem" },
  strong: { color: "var(--ink)", fontWeight: 700 },
  okBanner: {
    display: "flex",
    alignItems: "center",
    gap: "0.6rem",
    border: "1.5px solid var(--ink)",
    borderRadius: "var(--radius-md)",
    padding: "0.8rem 1.05rem",
    fontSize: "0.85rem",
    color: "var(--ink)",
    fontWeight: 600,
    marginBottom: "1.75rem",
  },
  section: { marginBottom: "3.5rem" },
  sectionTitle: {
    ...type.eyebrow,
    paddingBottom: "0.9rem",
    marginBottom: "1.5rem",
    borderBottom: "1px solid var(--rule)",
  },
  inviteForm: { display: "flex", gap: "0.75rem", alignItems: "center" },
  input: { ...input, flex: 1, minWidth: 0 },
  hint: { margin: "0.75rem 0 0", color: "var(--ink-muted)", fontSize: "0.8rem" },
  list: { borderTop: "1px solid var(--rule)" },
  row: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "1rem",
    padding: "1.1rem 0.25rem",
    borderBottom: "1px solid var(--rule)",
  },
  info: { display: "flex", flexDirection: "column", gap: "0.15rem" },
  name: { fontWeight: 600, fontSize: "0.9rem", color: "var(--ink)" },
  you: { color: "var(--ink-muted)", fontWeight: 400 },
  meta: { color: "var(--ink-muted)", fontSize: "0.78rem" },
  rowRight: {
    display: "flex",
    alignItems: "center",
    gap: "0.75rem",
    flexWrap: "wrap",
  },
  seatOn: {
    display: "inline-flex",
    alignItems: "center",
    gap: "0.4rem",
    background: "var(--ink)",
    color: "var(--paper)",
    border: "1px solid var(--ink)",
    borderRadius: "var(--radius-pill)",
    padding: "0.25rem 0.7rem",
    fontSize: "0.75rem",
    fontWeight: 600,
  },
};
