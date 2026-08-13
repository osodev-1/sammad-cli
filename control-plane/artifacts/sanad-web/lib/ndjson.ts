/**
 * Generic NDJSON stream reader for architect and coder agent streams.
 * Handles byte buffering across chunks, line splitting, and graceful EOF handling.
 */
export async function streamNdjson<T>(
  res: Response,
  onItem: (item: T) => void,
): Promise<void> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const flush = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      onItem(JSON.parse(trimmed) as T);
    } catch {
      /* skip a partial/garbled line */
    }
  };
  for (;;) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch {
      break; // aborted or connection dropped — the caller re-follows
    }
    if (chunk.done) break;
    buf += decoder.decode(chunk.value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      flush(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  }
  flush(buf);
}
