import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import Link from "next/link";
import type { CSSProperties } from "react";
import Nav from "../ui/Nav";
import { chip, surface, type } from "../ui/theme";
import { getLiveDeployment, listAgentsForOrgWithOwnerEmail } from "@/lib/agents/registry";
import { listRuns } from "@/lib/runs/store";
import { formatAge } from "./format";

export const metadata = { title: "sanad — agents" };

/**
 * Agents (P0 minimal page, Task 14): every agent in the org with its owner,
 * status, live deployment per env, and last run — read-only, server
 * rendered. Per-agent deployment/run lookups run in parallel (Promise.all)
 * rather than one mega-join, matching the same N-small-queries convention
 * ProjectsPage uses for its per-project session counts; P0's agent counts
 * are small enough that this stays cheap.
 */
export default async function AgentsPage() {
  const { userId } = await auth();
  if (!userId) redirect("/");

  const orgId = `personal_${userId}`;
  const agentRows = await listAgentsForOrgWithOwnerEmail(orgId);

  const rows = await Promise.all(
    agentRows.map(async (agent) => {
      const [dev, prod, lastRuns] = await Promise.all([
        getLiveDeployment(agent.id, "dev"),
        getLiveDeployment(agent.id, "prod"),
        listRuns({ orgId, agentId: agent.id, limit: 1 }),
      ]);
      return {
        ...agent,
        devStatus: dev?.status ?? null,
        prodStatus: prod?.status ?? null,
        lastRun: lastRuns[0] ?? null,
      };
    })
  );

  return (
    <div style={surface.page}>
      <Nav />
      <main className="pad-x" style={s.main}>
        <header style={s.header}>
          <h1 style={type.h1}>Agents</h1>
          <p style={{ ...type.small, marginTop: "0.5rem" }}>
            {rows.length} agent{rows.length === 1 ? "" : "s"} across this org.
          </p>
        </header>

        {rows.length === 0 ? (
          <p style={s.empty}>
            No agents yet — push one with{" "}
            <code style={s.inlineCode}>sanad agent deploy</code>.
          </p>
        ) : (
          <table style={s.table}>
            <thead>
              <tr>
                <th style={s.th}>Name</th>
                <th style={s.th}>Owner</th>
                <th style={s.th}>Status</th>
                <th style={s.th}>Dev</th>
                <th style={s.th}>Prod</th>
                <th style={s.th}>Last run</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((agent) => (
                <tr key={agent.id}>
                  <td style={s.td}>
                    <Link
                      href={`/agents/${encodeURIComponent(agent.name)}`}
                      className="link"
                    >
                      {agent.name}
                    </Link>
                  </td>
                  <td style={s.td}>{agent.ownerEmail}</td>
                  <td style={s.td}>
                    <span style={chip}>{agent.status}</span>
                  </td>
                  <td style={s.td}>{agent.devStatus ?? "—"}</td>
                  <td style={s.td}>{agent.prodStatus ?? "—"}</td>
                  <td style={s.td}>
                    {agent.lastRun
                      ? `${agent.lastRun.status} · ${formatAge(agent.lastRun.createdAt)}`
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </main>
    </div>
  );
}

const s: Record<string, CSSProperties> = {
  main: {
    maxWidth: "1000px",
    margin: "0 auto",
    padding: "3.5rem 2.5rem 5rem",
    width: "100%",
  },
  header: { marginBottom: "2.5rem" },
  empty: { ...type.small },
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
};
