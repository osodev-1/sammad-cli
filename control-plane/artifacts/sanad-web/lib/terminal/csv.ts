/**
 * A small RFC-4180 CSV parser: quoted fields may contain the delimiter,
 * newlines, and escaped quotes (""). Truly blank lines are dropped; an explicit
 * empty quoted field ("") is kept. Rows are capped for the preview. Pure, so it
 * unit-tests in node.
 */

export interface CsvData {
  rows: string[][];
  truncated: boolean;
}

export function parseCsv(
  text: string,
  maxRows = 1000,
  delimiter = ",",
): CsvData {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  let hasContent = false; // any character seen on the current row
  let truncated = false;

  const endRow = () => {
    row.push(field);
    field = "";
    if (!hasContent) {
      row = [];
      return; // blank line
    }
    if (rows.length < maxRows) rows.push(row);
    else truncated = true;
    row = [];
    hasContent = false;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      hasContent = true;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      hasContent = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = "";
      hasContent = true;
    } else if (ch === "\n") {
      endRow();
    } else if (ch === "\r") {
      // part of a CRLF pair — the following \n ends the row
    } else {
      field += ch;
      hasContent = true;
    }
  }
  if (hasContent || field.length > 0 || row.length > 0) endRow();

  return { rows, truncated };
}
