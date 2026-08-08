"use client";

import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { parseNotebook, type NotebookOutput } from "@/lib/terminal/notebook";

/**
 * Read-only Jupyter notebook viewer (S7 / TW-014). Renders cells top to bottom;
 * markdown cells and any HTML outputs are DOMPurify-sanitized, images ride as
 * data URLs, and nothing is ever executed — outputs are static data.
 */
export default function NotebookView({ content }: { content: string }) {
  const notebook = useMemo(() => parseNotebook(content), [content]);
  const [html, setHtml] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [{ marked }, { default: DOMPurify }] = await Promise.all([
        import("marked"),
        import("dompurify"),
      ]);
      const out: Record<string, string> = {};
      for (let i = 0; i < notebook.cells.length; i++) {
        const cell = notebook.cells[i];
        if (cell.type === "markdown") {
          out[`md-${i}`] = DOMPurify.sanitize(await marked.parse(cell.source));
        } else {
          cell.outputs.forEach((o, j) => {
            if (o.type === "html")
              out[`html-${i}-${j}`] = DOMPurify.sanitize(o.html);
          });
        }
      }
      if (!cancelled) setHtml(out);
    })().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [notebook]);

  if (notebook.error) return <div style={s.error}>{notebook.error}</div>;

  return (
    <div style={s.wrap}>
      {notebook.cells.map((cell, i) =>
        cell.type === "markdown" ? (
          <div key={i} style={s.mdCell}>
            {html[`md-${i}`] !== undefined ? (
              // Sanitized with DOMPurify above.
              <div
                style={s.markdown}
                dangerouslySetInnerHTML={{ __html: html[`md-${i}`] }}
              />
            ) : (
              <pre style={s.rawMd}>{cell.source}</pre>
            )}
          </div>
        ) : (
          <div key={i} style={s.codeCell}>
            <div style={s.codeRow}>
              <span style={s.gutter}>
                {cell.executionCount != null
                  ? `[${cell.executionCount}]`
                  : "[ ]"}
              </span>
              <pre style={s.code}>{cell.source || " "}</pre>
            </div>
            {cell.outputs.map((o, j) => (
              <Output key={j} output={o} html={html[`html-${i}-${j}`]} />
            ))}
          </div>
        ),
      )}
    </div>
  );
}

function Output({ output, html }: { output: NotebookOutput; html?: string }) {
  switch (output.type) {
    case "stream":
      return (
        <pre
          style={{
            ...s.output,
            ...(output.name === "stderr" ? s.stderr : null),
          }}
        >
          {output.text}
        </pre>
      );
    case "text":
      return <pre style={s.output}>{output.text}</pre>;
    case "error":
      return <pre style={{ ...s.output, ...s.stderr }}>{output.text}</pre>;
    case "image":
      return <img src={output.dataUrl} alt="cell output" style={s.image} />;
    case "html":
      return html !== undefined ? (
        // Sanitized with DOMPurify above.
        <div style={s.htmlOut} dangerouslySetInnerHTML={{ __html: html }} />
      ) : null;
  }
}

const mono = {
  fontFamily: "var(--font-mono)",
  fontSize: "0.78rem",
  lineHeight: 1.55,
} as const;

const s: Record<string, CSSProperties> = {
  wrap: {
    flex: 1,
    minHeight: 0,
    overflowY: "auto",
    padding: "1rem 1.1rem",
    display: "flex",
    flexDirection: "column",
    gap: "0.85rem",
  },
  error: { padding: "1.5rem", color: "var(--ink-muted)", fontSize: "0.9rem" },
  mdCell: { padding: "0 0.2rem" },
  markdown: { fontSize: "0.9rem", lineHeight: 1.65, color: "var(--ink)" },
  rawMd: {
    ...mono,
    whiteSpace: "pre-wrap",
    color: "var(--ink-soft)",
    margin: 0,
  },
  codeCell: {
    border: "1px solid var(--rule)",
    borderRadius: "var(--radius-md)",
    overflow: "hidden",
    background: "var(--paper)",
  },
  codeRow: {
    display: "flex",
    gap: "0.5rem",
    background: "var(--paper-sunken)",
  },
  gutter: {
    ...mono,
    color: "var(--ink-muted)",
    padding: "0.6rem 0.5rem",
    userSelect: "none",
    flexShrink: 0,
  },
  code: {
    ...mono,
    margin: 0,
    padding: "0.6rem 0.6rem 0.6rem 0",
    color: "var(--ink)",
    whiteSpace: "pre-wrap",
    overflowX: "auto",
    flex: 1,
    minWidth: 0,
  },
  output: {
    ...mono,
    margin: 0,
    padding: "0.5rem 0.7rem",
    borderTop: "1px solid var(--rule)",
    color: "var(--ink-soft)",
    whiteSpace: "pre-wrap",
    overflowX: "auto",
  },
  stderr: { color: "var(--ink)", background: "var(--paper-sunken)" },
  image: {
    display: "block",
    maxWidth: "100%",
    padding: "0.6rem 0.7rem",
    borderTop: "1px solid var(--rule)",
  },
  htmlOut: {
    padding: "0.5rem 0.7rem",
    borderTop: "1px solid var(--rule)",
    fontSize: "0.82rem",
    color: "var(--ink)",
    overflowX: "auto",
  },
};
