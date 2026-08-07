import {
  encodeControl,
  parseServerControl,
  parseSessionGrant,
} from "@/lib/terminal/protocol";

/**
 * Subscribe to blueprint change events for a project session.
 *
 * Mints a terminal ticket, opens the PTY-less `mode:"events"` WebSocket, and
 * calls `onChange` whenever the machine reports that the `.sanad` tree changed
 * — an external edit the browser did not make (a PTY-agent write, a `git
 * checkout`). Self-heals with capped backoff. Returns a disposer.
 *
 * This is a best-effort freshness boost layered over GraphPanel's 4s poll
 * (NF-001): a dropped socket only means the poll carries the change instead,
 * never a stall, so the reconnection logic is deliberately simple.
 */
export function subscribeBlueprintEvents(
  onChange: () => void,
  sessionId?: string,
): () => void {
  let disposed = false;
  let ws: WebSocket | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let lastVersion: number | null = null;

  const clearTimers = () => {
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  };

  const scheduleReconnect = () => {
    if (disposed || retryTimer) return;
    const backoff = Math.min(30_000, 1_000 * 2 ** attempt);
    attempt += 1;
    retryTimer = setTimeout(
      () => {
        retryTimer = null;
        void connect();
      },
      backoff + Math.random() * 500,
    );
  };

  const connect = async () => {
    if (disposed) return;
    let grant: ReturnType<typeof parseSessionGrant> = null;
    try {
      const res = await fetch("/api/terminal/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(sessionId ? { sessionId } : {}),
      });
      if (res.ok) grant = parseSessionGrant(await res.json().catch(() => null));
    } catch {
      /* fall through to reconnect */
    }
    if (disposed) return;
    if (!grant) {
      scheduleReconnect();
      return;
    }

    const ticket = grant.ticket;
    const socket = new WebSocket(grant.wsUrl);
    ws = socket;

    socket.onopen = () => {
      socket.send(encodeControl({ type: "auth", ticket, mode: "events" }));
      pingTimer = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(encodeControl({ type: "ping" }));
        }
      }, 25_000);
    };

    socket.onmessage = (ev) => {
      if (typeof ev.data !== "string") return;
      const msg = parseServerControl(ev.data);
      if (!msg) return;
      if (msg.type === "event" && msg.channel === "blueprint") {
        attempt = 0; // a healthy stream re-arms the backoff ladder
        // The first frame echoes the current version (a baseline); fire only
        // when a later frame reports a genuinely newer one.
        if (lastVersion !== null && msg.version !== lastVersion) onChange();
        lastVersion = msg.version;
      } else if (msg.type === "error") {
        socket.close();
      }
    };

    socket.onclose = () => {
      clearTimers();
      if (ws === socket) ws = null;
      lastVersion = null;
      scheduleReconnect();
    };
    // onerror is followed by onclose, which owns the retry.
    socket.onerror = () => {};
  };

  void connect();

  return () => {
    disposed = true;
    clearTimers();
    if (ws) {
      ws.onclose = null; // our teardown is not a reconnect trigger
      ws.close();
      ws = null;
    }
  };
}
