/**
 * A tolerant .ipynb parser. Normalizes the notebook JSON into a flat list of
 * cells + outputs for read-only rendering — outputs are DATA, never executed
 * (TW-014 / FS-011). Any malformed field degrades to empty rather than throwing.
 */

export type NotebookOutput =
  | { type: "stream"; name: string; text: string }
  | { type: "text"; text: string }
  | { type: "image"; dataUrl: string }
  | { type: "html"; html: string }
  | { type: "error"; text: string };

export type NotebookCell =
  | { type: "markdown"; source: string }
  | {
      type: "code";
      source: string;
      executionCount: number | null;
      outputs: NotebookOutput[];
    };

export interface Notebook {
  cells: NotebookCell[];
  language: string | null;
  /** Set when the file could not be parsed as a notebook at all. */
  error?: string;
}

/** ipynb `source`/`text` fields are a string OR an array of lines. */
function joinSource(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v))
    return v.map((x) => (typeof x === "string" ? x : "")).join("");
  return "";
}

// Strip the color codes tracebacks are full of (matches the "[NNm" tail; a
// lone leading ESC byte, if any, renders as nothing in the <pre>).
const ANSI = /\[[0-9;]*m/g;
const stripAnsi = (s: string) => s.replace(ANSI, "");

function firstString(
  data: Record<string, unknown>,
  mime: string,
): string | null {
  const v = data[mime];
  if (v === undefined) return null;
  return joinSource(v);
}

function parseOutput(raw: unknown): NotebookOutput | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  switch (o.output_type) {
    case "stream":
      return {
        type: "stream",
        name: typeof o.name === "string" ? o.name : "stdout",
        text: joinSource(o.text),
      };
    case "error":
      return {
        type: "error",
        text: stripAnsi(
          Array.isArray(o.traceback)
            ? o.traceback
                .map((x) => (typeof x === "string" ? x : ""))
                .join("\n")
            : `${o.ename ?? "Error"}: ${o.evalue ?? ""}`,
        ),
      };
    case "execute_result":
    case "display_data": {
      const data = (
        o.data && typeof o.data === "object" ? o.data : {}
      ) as Record<string, unknown>;
      for (const mime of ["image/png", "image/jpeg", "image/gif"]) {
        const b64 = firstString(data, mime);
        if (b64)
          return {
            type: "image",
            dataUrl: `data:${mime};base64,${b64.replace(/\s/g, "")}`,
          };
      }
      const svg = firstString(data, "image/svg+xml");
      if (svg) return { type: "html", html: svg };
      const html = firstString(data, "text/html");
      if (html) return { type: "html", html };
      const text = firstString(data, "text/plain");
      if (text !== null) return { type: "text", text };
      return null;
    }
    default:
      return null;
  }
}

function parseCell(raw: unknown): NotebookCell | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  const source = joinSource(c.source);
  if (c.cell_type === "markdown" || c.cell_type === "raw") {
    return { type: "markdown", source };
  }
  if (c.cell_type === "code") {
    const outputs = Array.isArray(c.outputs)
      ? c.outputs
          .map(parseOutput)
          .filter((o): o is NotebookOutput => o !== null)
      : [];
    const ec = c.execution_count;
    return {
      type: "code",
      source,
      executionCount: typeof ec === "number" ? ec : null,
      outputs,
    };
  }
  return null;
}

export function parseNotebook(raw: string): Notebook {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return {
      cells: [],
      language: null,
      error: "This file is not valid notebook JSON.",
    };
  }
  if (
    !doc ||
    typeof doc !== "object" ||
    !Array.isArray((doc as { cells?: unknown }).cells)
  ) {
    return {
      cells: [],
      language: null,
      error: "This file is not a Jupyter notebook.",
    };
  }
  const d = doc as Record<string, unknown>;
  const cells = (d.cells as unknown[])
    .map(parseCell)
    .filter((c): c is NotebookCell => c !== null);

  let language: string | null = null;
  const meta = d.metadata;
  if (meta && typeof meta === "object") {
    const li = (meta as Record<string, unknown>).language_info;
    if (li && typeof li === "object") {
      const name = (li as Record<string, unknown>).name;
      if (typeof name === "string") language = name;
    }
  }
  return { cells, language };
}
