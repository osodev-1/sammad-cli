"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { CSSProperties } from "react";
import Nav from "../ui/Nav";
import { PencilIcon } from "../ui/icons";
import { button, size, surface, type } from "../ui/theme";

export interface ProjectRow {
  id: string;
  name: string;
  state: string;
  sessionCount: number;
  lastActiveAt: string;
}

/**
 * The Projects list. Opening a project routes to the workspace, which restores
 * that project's saved session state (tabs, drawer, layout).
 */
export default function ProjectsClient({
  projects: initial,
  awsMode,
}: {
  projects: ProjectRow[];
  awsMode: boolean;
}) {
  const router = useRouter();
  const [projects, setProjects] = useState(initial);
  const [editing, setEditing] = useState<{ id: string; draft: string } | null>(
    null,
  );

  const open = (id: string) => {
    try {
      window.localStorage.setItem("sanad-ws-active-session", id);
    } catch {
      /* storage blocked — the workspace falls back to the first project */
    }
    router.push("/terminal");
  };

  const commitRename = async () => {
    if (!editing) return;
    const name = editing.draft.trim();
    const { id } = editing;
    setEditing(null);
    if (!name) return;
    setProjects((prev) => prev.map((p) => (p.id === id ? { ...p, name } : p)));
    await fetch(`/api/sessions/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    }).catch(() => {
      /* optimistic; the next load resyncs */
    });
  };

  return (
    <div style={s.root}>
      <Nav
        links={[
          { href: "/terminal", label: "Workspace", badge: "beta" },
          { href: "/dashboard", label: "Dashboard" },
          { href: "/pricing", label: "Pricing", compactHidden: true },
        ]}
      />
      <main className="pad-x" style={s.main}>
        <header style={s.header}>
          <h1 style={type.h1}>Projects</h1>
          <p style={type.body}>
            Each project is its own machine and workspace. Open one to resume
            its files, terminals, and layout exactly where you left off.
          </p>
        </header>

        {!awsMode ? (
          <p style={type.small}>
            Projects are available on the cloud workspace.
          </p>
        ) : projects.length === 0 ? (
          <div style={s.empty}>
            <p style={type.body}>You don&rsquo;t have a project yet.</p>
            <button
              style={button.primary(size.md)}
              onClick={() => router.push("/terminal")}
            >
              Open the workspace
            </button>
          </div>
        ) : (
          <ul style={s.list}>
            {projects.map((p) => (
              <li key={p.id} style={surface.card}>
                <div style={s.row}>
                  <div style={s.info}>
                    {editing?.id === p.id ? (
                      <input
                        autoFocus
                        style={s.input}
                        value={editing.draft}
                        maxLength={40}
                        onChange={(e) =>
                          setEditing({ id: p.id, draft: e.target.value })
                        }
                        onBlur={commitRename}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void commitRename();
                          else if (e.key === "Escape") setEditing(null);
                        }}
                      />
                    ) : (
                      <div style={s.nameRow}>
                        <span style={s.name}>{p.name}</span>
                        <button
                          type="button"
                          style={s.iconButton}
                          title="Rename project"
                          aria-label={`Rename ${p.name}`}
                          onClick={() =>
                            setEditing({ id: p.id, draft: p.name })
                          }
                        >
                          <PencilIcon size={13} />
                        </button>
                      </div>
                    )}
                    <span style={type.small}>
                      {p.sessionCount} session{p.sessionCount === 1 ? "" : "s"}{" "}
                      · last active{" "}
                      {new Date(p.lastActiveAt).toLocaleDateString()}
                    </span>
                  </div>
                  <button
                    style={button.secondary(size.sm)}
                    onClick={() => open(p.id)}
                  >
                    Open
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}

const s: Record<string, CSSProperties> = {
  root: {
    minHeight: "100dvh",
    display: "flex",
    flexDirection: "column",
    background: "var(--paper)",
  },
  main: {
    flex: 1,
    maxWidth: "760px",
    width: "100%",
    margin: "0 auto",
    padding: "2.5rem 0 4rem",
  },
  header: {
    display: "flex",
    flexDirection: "column",
    gap: "0.6rem",
    marginBottom: "2rem",
  },
  empty: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: "1rem",
    ...surface.card,
  },
  list: {
    listStyle: "none",
    padding: 0,
    margin: 0,
    display: "flex",
    flexDirection: "column",
    gap: "0.75rem",
  },
  row: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "1rem",
  },
  info: {
    display: "flex",
    flexDirection: "column",
    gap: "0.3rem",
    minWidth: 0,
  },
  nameRow: { display: "flex", alignItems: "center", gap: "0.4rem" },
  name: { fontSize: "1rem", fontWeight: 650, color: "var(--ink)" },
  iconButton: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "24px",
    height: "24px",
    background: "none",
    border: "none",
    borderRadius: "var(--radius-sm)",
    color: "var(--ink-muted)",
    cursor: "pointer",
    padding: 0,
  },
  input: {
    font: "inherit",
    fontSize: "1rem",
    fontWeight: 650,
    color: "var(--ink)",
    background: "var(--paper)",
    border: "1px solid var(--rule-strong)",
    borderRadius: "var(--radius-sm)",
    padding: "0.15rem 0.4rem",
    outline: "none",
  },
};
