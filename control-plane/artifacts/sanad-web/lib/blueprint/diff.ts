/**
 * Dependency-free line diff for the plan review modal (R2).
 *
 * A classic LCS over lines — exact, not heuristic — sized for manifests and
 * skill instructions, not for source trees: beyond MAX_LINES the caller falls
 * back to full-content rendering (`null` return), which is always correct.
 */

export type DiffLine =
  | { kind: "same"; text: string }
  | { kind: "add"; text: string }
  | { kind: "del"; text: string };

export interface DiffHunk {
  /** 1-based first line numbers in the before/after texts. */
  beforeLine: number;
  afterLine: number;
  lines: DiffLine[];
}

const MAX_LINES = 2000;

function splitLines(text: string): string[] {
  const lines = text.split("\n");
  // A trailing newline yields one phantom empty element — drop it so the
  // diff speaks in real lines.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Full line diff, or null when either side is too large to diff exactly. */
export function diffLines(before: string, after: string): DiffLine[] | null {
  const a = splitLines(before);
  const b = splitLines(after);
  if (a.length > MAX_LINES || b.length > MAX_LINES) return null;

  // LCS lengths, iterative DP.
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  const dp = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * width + j] =
        a[i] === b[j]
          ? dp[(i + 1) * width + j + 1] + 1
          : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i] });
      i++;
      j++;
    } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
      out.push({ kind: "del", text: a[i] });
      i++;
    } else {
      out.push({ kind: "add", text: b[j] });
      j++;
    }
  }
  for (; i < n; i++) out.push({ kind: "del", text: a[i] });
  for (; j < m; j++) out.push({ kind: "add", text: b[j] });
  return out;
}

/**
 * Group a diff into hunks with `context` unchanged lines around each change,
 * eliding long same-runs — what the review modal renders. Empty array means
 * the texts are identical.
 */
export function diffHunks(
  before: string,
  after: string,
  context = 3,
): DiffHunk[] | null {
  const diff = diffLines(before, after);
  if (diff === null) return null;
  if (!diff.some((l) => l.kind !== "same")) return [];

  // Mark which indices are kept (changes + context window around them).
  const keep = new Array<boolean>(diff.length).fill(false);
  for (let k = 0; k < diff.length; k++) {
    if (diff[k].kind !== "same") {
      for (
        let w = Math.max(0, k - context);
        w <= Math.min(diff.length - 1, k + context);
        w++
      ) {
        keep[w] = true;
      }
    }
  }

  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;
  let beforeLine = 1;
  let afterLine = 1;
  for (let k = 0; k < diff.length; k++) {
    const line = diff[k];
    if (keep[k]) {
      if (!current) {
        current = { beforeLine, afterLine, lines: [] };
        hunks.push(current);
      }
      current.lines.push(line);
    } else {
      current = null;
    }
    if (line.kind !== "add") beforeLine++;
    if (line.kind !== "del") afterLine++;
  }
  return hunks;
}
