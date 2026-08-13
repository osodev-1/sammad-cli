import { auth } from "@clerk/nextjs/server";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import type { CSSProperties } from "react";
import Nav from "../../ui/Nav";
import { chip, surface, type } from "../../ui/theme";
import { getAgentDetailByName, getLiveDeployment } from "@/lib/agents/registry";
import { listRuns } from "@/lib/runs/store";
import { formatAge, formatUsd } from "../format";

export const metadata = { title: "sanad — agent" };

/**
 * Agent detail (P0 minimal page, Task 14): owner + status + the live
 * deployment per env, and the last 20 runs — read-only, server rendered.
 * No pause/resume affordance here; those stay CLI verbs (`sanad agent
 * pause`/`resume`) in P0.
 */
export default async function AgentDetailPage({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  const { userId } = await auth();
  if (!userId) redirect("/");

  const orgId = `personal_${userId}`;
  const { name } = await params;
  const agent = await getAgentDetailByName(orgId, name);
  if (!agent) notFound();

  const [dev, prod, runs] = await Promise.all([
    getLiveDeployment(agent.id, "dev"),
    getLiveDeployment(agent.id, "prod"),
    listRuns({ orgId, agentId: agent.id, limit: 20 }),
  ]);

  const deployments = [
    { env: "dev", deployment: dev },
    { env: "prod", deployment: prod },
  ];

  return (
    <div style={surface.page}>
      <Nav />
      <main className="pad-x" style={s.main}>
        <p style={s.breadcrumb}>
          <Link href="/agents" className="link">
            Agents
          </Link>
        </p>

        <header style={s.header}>
          <h1 style={type.h1}>{agent.name}</h1>
          <p style={s.sub}>
            {agent.ownerEmail}
            <span style={s.dot}>·</span>
            <span style={chip}>{agent.status}</span>
          </p>
        </header>

        <section style={s.section}>
          <h2 style={type.eyebrow}>Deployments</h2>
          <table style={s.table}>
            <thead>
              <tr>
                <th style={s.th}>Env</th>
                <th style={s.th}>Status</th>
                <th style={s.th}>Version</th>
                <th style={s.th}>Updated</th>
              </tr>
            </thead>
            <tbody>
              {deployments.map(({ env, deployment }) => (
                <tr key={env}>
                  <td style={s.td}>{env}</td>
                  <td style={s.td}>{deployment?.status ?? "not deployed"}</td>
                  <td style={s.td}>
                    {deployment ? (
                      <code style={s.mono}>{deployment.agentVersionId}</code>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td style={s.td}>
                    {deployment ? formatAge(deployment.updatedAt) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section style={s.section}>
          <h2 style={type.eyebrow}>Last runs</h2>
          {runs.length === 0 ? (
            <p style={s.empty}>No runs yet.</p>
          ) : (
            <table style={s.table}>
              <thead>
                <tr>
                  <th style={s.th}>Run</th>
                  <th style={s.th}>Status</th>
                  <th style={{ ...s.th, textAlign: "right" }}>Cost</th>
                  <th style={{ ...s.th, textAlign: "right" }}>Tokens in</th>
                  <th style={{ ...s.th, textAlign: "right" }}>Tokens out</th>
                  <th style={s.th}>Age</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.id}>
                    <td style={s.td}>
                      <code style={s.mono}>{run.id}</code>
                    </td>
                    <td style={s.td}>{run.status}</td>
                    <td style={{ ...s.td, textAlign: "right" }}>
                      {formatUsd(run.costUsdMicros)}
                    </td>
                    <td style={{ ...s.td, textAlign: "right" }}>
                      {run.tokensIn.toLocaleString()}
                    </td>
                    <td style={{ ...s.td, textAlign: "right" }}>
                      {run.tokensOut.toLocaleString()}
                    </td>
                    <td style={s.td}>{formatAge(run.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </main>
    </div>
  );
}

const s: Record<string, CSSProperties> = {
  main: {
    maxWidth: "1000px",
    margin: "0 auto",
    padding: "2.5rem 2.5rem 5rem",
    width: "100%",
  },
  breadcrumb: { ...type.small, marginBottom: "1.5rem" },
  header: { marginBottom: "2.5rem" },
  sub: {
    margin: "0.5rem 0 0",
    display: "flex",
    alignItems: "center",
    color: "var(--ink-muted)",
    fontSize: "0.875rem",
  },
  dot: { margin: "0 0.55rem", color: "var(--rule-strong)" },
  section: { marginBottom: "3rem" },
  empty: { ...type.small },
  mono: {
    fontFamily: "var(--font-mono)",
    fontSize: "0.8rem",
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
