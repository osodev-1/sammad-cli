"use client";

import "@xterm/xterm/css/xterm.css";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { IDisposable, Terminal as XTerm } from "@xterm/xterm"; // type-only — erased
import type { FitAddon } from "@xterm/addon-fit";
import {
  classifyConflict,
  encodeControl,
  isBlockedCode,
  parseServerControl,
  parseSessionGrant,
  type BlockedCode,
  type ClientControl,
} from "@/lib/terminal/protocol";
import { XTERM_OPTIONS } from "@/lib/terminal/xtermTheme";
import { button, size, type } from "../ui/theme";

export type TerminalPhase =
  | { tag: "connecting" }
  | { tag: "live" }
  | { tag: "exited"; code: number | null }
  | { tag: "conflict"; kind: "taken_over" | "refused" }
  | { tag: "disconnected" }
  | { tag: "blocked"; code: BlockedCode }
  | { tag: "error"; message: string };

/*
 * All PTY input goes through these helpers — a bare ws.send(string) would be
 * parsed server-side as a control frame.
 */
const sendData = (ws: WebSocket | null, data: string) => {
  if (ws?.readyState === WebSocket.OPEN) ws.send(new TextEncoder().encode(data));
};
const sendBinary = (ws: WebSocket | null, data: string) => {
  if (ws?.readyState !== WebSocket.OPEN) return;
  const buf = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) buf[i] = data.charCodeAt(i) & 0xff;
  ws.send(buf);
};
const sendControl = (ws: WebSocket | null, msg: ClientControl) => {
  if (ws?.readyState === WebSocket.OPEN) ws.send(encodeControl(msg));
};

interface Props {
  /** The panel stays mounted through tab switches; false just hides it. */
  visible: boolean;
  onPhaseChange?: (phase: TerminalPhase) => void;
}

export default function TerminalPanel({ visible, onPhaseChange }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const fitTimer = useRef<number | null>(null);

  const [ready, setReady] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [phase, setPhaseRaw] = useState<TerminalPhase>({ tag: "connecting" });

  const phaseRef = useRef(phase);
  const setPhase = useCallback(
    (p: TerminalPhase | ((prev: TerminalPhase) => TerminalPhase)) => {
      setPhaseRaw((prev) => {
        const next = typeof p === "function" ? p(prev) : p;
        phaseRef.current = next;
        onPhaseChange?.(next);
        return next;
      });
    },
    [onPhaseChange]
  );

  /* Debounced fit: refit locally; only tell the PTY when the grid changed. */
  const scheduleFit = useCallback(() => {
    if (fitTimer.current !== null) return;
    fitTimer.current = window.setTimeout(() => {
      fitTimer.current = null;
      const term = termRef.current;
      const fit = fitRef.current;
      if (!term || !fit) return;
      const { cols, rows } = term;
      try {
        fit.fit();
      } catch {
        return;
      }
      if (term.cols !== cols || term.rows !== rows) {
        sendControl(wsRef.current, { type: "resize", cols: term.cols, rows: term.rows });
      }
    }, 120);
  }, []);

  /* ---- Effect A: terminal lifecycle (mount once, survive reconnects) ----
     xterm touches `self` at module scope → imported here, after mount. The
     `disposed` flag stops StrictMode's first pass from opening a terminal
     into a torn-down tree. */
  useEffect(() => {
    let disposed = false;
    let ro: ResizeObserver | null = null;

    (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);
      if (disposed || !hostRef.current) return;

      const term = new Terminal(XTERM_OPTIONS);
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(hostRef.current);

      try {
        const { WebglAddon } = await import("@xterm/addon-webgl");
        if (!disposed) {
          const webgl = new WebglAddon();
          webgl.onContextLoss(() => webgl.dispose()); // xterm falls back to DOM
          term.loadAddon(webgl);
        }
      } catch {
        /* WebGL unavailable — the DOM renderer carries on. */
      }
      if (disposed) {
        term.dispose();
        return;
      }

      /* Cmd+K clears, like a native terminal. Nothing else is intercepted —
         Ctrl+C must reach the PTY as SIGINT. */
      term.attachCustomKeyEventHandler((e) => {
        if (e.type === "keydown" && e.metaKey && !e.ctrlKey && e.key === "k") {
          term.clear();
          return false;
        }
        return true;
      });

      try {
        fit.fit();
      } catch {
        /* container not laid out yet — the ResizeObserver will correct it */
      }
      termRef.current = term;
      fitRef.current = fit;
      ro = new ResizeObserver(scheduleFit);
      ro.observe(hostRef.current);
      setReady(true);
    })();

    return () => {
      disposed = true;
      ro?.disconnect();
      if (fitTimer.current !== null) window.clearTimeout(fitTimer.current);
      fitTimer.current = null;
      termRef.current?.dispose();
      termRef.current = null;
      fitRef.current = null;
      setReady(false);
    };
  }, [scheduleFit]);

  /* Hidden→visible tab switches change the host size from 0 — refit. */
  useEffect(() => {
    if (visible) scheduleFit();
  }, [visible, scheduleFit]);

  /* ---- Effect B: session + socket (re-runs per reconnect generation) ---- */
  useEffect(() => {
    if (!ready) return;
    const term = termRef.current;
    if (!term) return;
    let cancelled = false;
    const ac = new AbortController();
    let ws: WebSocket | null = null;
    let ping: number | null = null;
    const subs: IDisposable[] = [];

    setPhase({ tag: "connecting" });

    (async () => {
      let res: Response;
      try {
        res = await fetch("/api/terminal/session", { method: "POST", signal: ac.signal });
      } catch {
        if (!cancelled) {
          setPhase({ tag: "error", message: "Network error — check your connection." });
        }
        return;
      }
      const body = await res.json().catch(() => null);
      if (cancelled) return;

      if (!res.ok) {
        const code = body?.error?.code;
        if (isBlockedCode(code)) setPhase({ tag: "blocked", code });
        else {
          setPhase({
            tag: "error",
            message: body?.error?.message ?? "Could not start a session.",
          });
        }
        return;
      }
      const grant = parseSessionGrant(body);
      if (!grant) {
        setPhase({ tag: "error", message: "Malformed session response." });
        return;
      }

      ws = new WebSocket(grant.wsUrl);
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

      ws.onopen = () => {
        if (cancelled || !ws) return;
        // The ticket travels in the first frame, never in the URL.
        sendControl(ws, {
          type: "auth",
          ticket: grant.ticket,
          cols: term.cols,
          rows: term.rows,
        });
      };

      ws.onmessage = (ev) => {
        if (cancelled) return;
        if (typeof ev.data === "string") {
          const msg = parseServerControl(ev.data);
          if (!msg) return; // unknown control frames are never fatal
          switch (msg.type) {
            case "ready": {
              setPhase({ tag: "live" });
              subs.push(term.onData((d) => sendData(ws, d)));
              subs.push(term.onBinary((d) => sendBinary(ws, d)));
              term.focus();
              /* Keepalive for idle proxies; the server also sends transport
                 pings. Background-tab throttling (~1/min) still suffices. */
              ping = window.setInterval(() => sendControl(ws, { type: "ping" }), 30_000);
              break;
            }
            case "warning":
              term.writeln(
                `\r\n\x1b[2m— idle: session closes in ${Math.round(msg.secondsLeft / 60)}m without input —\x1b[0m`
              );
              break;
            case "exit":
              setPhase({ tag: "exited", code: msg.code });
              break;
            case "error": {
              const kind = classifyConflict(msg.code);
              if (kind) setPhase({ tag: "conflict", kind });
              else if (msg.code === "idle_timeout") {
                setPhase({ tag: "error", message: "Session closed after inactivity." });
              } else if (msg.code === "max_lifetime") {
                setPhase({ tag: "error", message: "Session reached its maximum length." });
              } else {
                setPhase({ tag: "error", message: msg.message ?? msg.code });
              }
              break;
            }
            case "pong":
              break;
          }
        } else {
          term.write(new Uint8Array(ev.data as ArrayBuffer));
        }
      };

      ws.onclose = () => {
        if (cancelled) return;
        wsRef.current = null;
        /* A close after exit/conflict/blocked keeps that richer phase; a
           close out of live/connecting is a genuine drop. */
        setPhase((p) =>
          p.tag === "live" || p.tag === "connecting" ? { tag: "disconnected" } : p
        );
      };
    })();

    return () => {
      cancelled = true;
      ac.abort();
      for (const d of subs) d.dispose();
      if (ping !== null) window.clearInterval(ping);
      wsRef.current = null;
      ws?.close(1000, "client teardown");
    };
  }, [ready, generation, setPhase]);

  const reconnect = useCallback(() => {
    termRef.current?.writeln("\r\n\x1b[2m— reconnecting —\x1b[0m");
    setGeneration((g) => g + 1); // Effect B rebuilds; the scrollback survives
  }, []);

  const overlay = phase.tag === "blocked" ? null : overlayFor(phase);
  return (
    <div style={{ ...s.body, ...(visible ? null : s.hidden) }}>
      <div
        ref={hostRef}
        style={{ ...s.host, ...(phase.tag === "live" ? null : s.hostDimmed) }}
      />
      {phase.tag === "blocked" ? (
        <BlockedPanel code={phase.code} />
      ) : (
        overlay && <Overlay overlay={overlay} phase={phase} onReconnect={reconnect} />
      )}
    </div>
  );
}

/* ------------------------------------------------------------- overlays --- */

interface OverlayCopy {
  title: string;
  body: string;
  cta: string;
}

function overlayFor(phase: TerminalPhase): OverlayCopy | null {
  switch (phase.tag) {
    case "connecting":
      return { title: "connecting…", body: "", cta: "" };
    case "disconnected":
      return {
        title: "Connection lost",
        body: "Your workspace is safe — files and history are kept for you.",
        cta: "Reconnect",
      };
    case "exited":
      return {
        title: "Session ended",
        body: phase.code
          ? `The agent exited with code ${phase.code}.`
          : "The agent exited.",
        cta: "Start again",
      };
    case "conflict":
      return phase.kind === "taken_over"
        ? {
            title: "Opened elsewhere",
            body: "This workspace was opened in a newer tab or device.",
            cta: "Continue here",
          }
        : {
            title: "Already open elsewhere",
            body: "Your workspace is live in another tab.",
            cta: "Continue here instead",
          };
    case "error":
      return { title: "Something went wrong", body: phase.message, cta: "Try again" };
    default:
      return null;
  }
}

function Overlay({
  overlay,
  phase,
  onReconnect,
}: {
  overlay: OverlayCopy;
  phase: TerminalPhase;
  onReconnect: () => void;
}) {
  if (phase.tag === "connecting") {
    return (
      <div style={s.overlay}>
        <span style={s.overlayEyebrow}>connecting…</span>
      </div>
    );
  }
  return (
    <div style={s.overlay}>
      <div style={s.overlayPanel}>
        <span style={s.overlayEyebrow}>{overlay.title}</span>
        {overlay.body && <p style={s.overlayBody}>{overlay.body}</p>}
        <button style={button.onInvert(size.md)} onClick={onReconnect}>
          {overlay.cta}
        </button>
      </div>
    </div>
  );
}

function BlockedPanel({ code }: { code: BlockedCode }) {
  const copy = {
    terminal_not_enabled: {
      title: "Limited beta",
      body: "The browser workspace is rolling out gradually and your account isn't on the access list yet. Your CLI access is unaffected.",
      cta: null as { href: string; label: string } | null,
    },
    no_plan: {
      title: "Plan required",
      body: "The browser workspace needs an active subscription.",
      cta: { href: "/pricing", label: "View plans" },
    },
    no_seat: {
      title: "Seat required",
      body: "Ask your team admin to assign you a seat.",
      cta: null,
    },
  }[code];
  return (
    <div style={s.overlay}>
      <div style={s.overlayPanel}>
        <span style={s.overlayEyebrow}>{copy.title}</span>
        <p style={s.overlayBody}>{copy.body}</p>
        {copy.cta && (
          <Link href={copy.cta.href} style={button.onInvert(size.md)}>
            {copy.cta.label}
          </Link>
        )}
      </div>
    </div>
  );
}

const s: Record<string, CSSProperties> = {
  body: {
    position: "relative",
    flex: 1,
    minHeight: 0,
    display: "flex",
  },
  hidden: {
    /* Keep the terminal mounted (buffer, socket) but out of view. */
    position: "absolute",
    inset: 0,
    visibility: "hidden",
    pointerEvents: "none",
  },
  host: {
    flex: 1,
    minWidth: 0,
    padding: "0.9rem 0.4rem 0.9rem 1.1rem",
  },
  hostDimmed: { opacity: 0.35, transition: "opacity 0.2s ease" },
  overlay: {
    position: "absolute",
    inset: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "1.5rem",
  },
  overlayPanel: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "0.9rem",
    maxWidth: "380px",
    textAlign: "center",
    background: "var(--invert-surface)",
    border: "1px solid rgba(255,255,255,0.18)",
    borderRadius: "var(--radius-md)",
    padding: "1.75rem 2rem",
  },
  overlayEyebrow: { ...type.eyebrow, color: "var(--invert-muted)" },
  overlayBody: {
    margin: 0,
    fontSize: "0.875rem",
    lineHeight: 1.6,
    color: "var(--invert-ink)",
  },
};
