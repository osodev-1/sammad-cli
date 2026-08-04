"use client";

import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { useSearchParams } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import {
  AlertTriangleIcon,
  CheckSolidIcon,
  CrossOutlineIcon,
} from "../ui/icons";
import { button, disabled, size, state, surface, type } from "../ui/theme";
import SanadLogo from "../ui/SanadLogo";

type ApproveState = "idle" | "loading" | "approved" | "denied" | "error";

export default function DevicePageContent() {
  const { isLoaded, isSignedIn } = useUser();
  const searchParams = useSearchParams();
  const code = searchParams.get("code") ?? "";

  const [approveState, setState] = useState<ApproveState>("idle");
  const [errorMsg, setErrorMsg] = useState("");

  useEffect(() => {
    if (isLoaded && !isSignedIn) {
      window.location.href = `/sign-in?redirect_url=${encodeURIComponent(window.location.href)}`;
    }
  }, [isLoaded, isSignedIn]);

  async function handleAction(action: "approve" | "deny") {
    if (!code) {
      setErrorMsg(
        "No device code found in the URL. Please reopen the link from your terminal."
      );
      setState("error");
      return;
    }
    setState("loading");
    try {
      const res = await fetch("/api/device/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userCode: code, action }),
      });
      const json = await res.json();
      if (!res.ok) {
        const msg = json?.error?.message ?? "An error occurred";
        const errCode = json?.error?.code ?? "";
        if (errCode === "no_seat") {
          setErrorMsg(
            "No seat assigned — ask your admin to assign you a seat on your organization plan."
          );
        } else if (errCode === "no_plan") {
          setErrorMsg("No active subscription. Visit /pricing to upgrade.");
        } else {
          setErrorMsg(msg);
        }
        setState("error");
        return;
      }
      setState(action === "approve" ? "approved" : "denied");
    } catch {
      setErrorMsg("Network error. Please try again.");
      setState("error");
    }
  }

  if (!isLoaded) return <Screen title="Loading…" />;
  if (!isSignedIn) return <Screen title="Redirecting to sign-in…" />;

  if (approveState === "approved") {
    return (
      <Screen title="Device connected">
        <p style={s.desc}>
          Your terminal is now linked. Return to your terminal — the{" "}
          <code style={s.inlineCode}>sanad login</code> command should complete
          automatically.
        </p>
        {/* Success: solid ink fill, knocked-out mark. */}
        <div style={state.successBadge}>
          <CheckSolidIcon size={17} knockout="var(--ink)" />
          Approved
        </div>
      </Screen>
    );
  }

  if (approveState === "denied") {
    return (
      <Screen title="Request denied">
        <p style={s.desc}>
          The CLI login request was denied. If this was a mistake, run{" "}
          <code style={s.inlineCode}>sanad login</code> again in your terminal.
        </p>
        {/* Denial: the inverse of success — outlined, heavy, crossed. */}
        <div style={state.dangerBadge}>
          <CrossOutlineIcon size={17} />
          Denied
        </div>
      </Screen>
    );
  }

  if (approveState === "error") {
    return (
      <Screen title="Something went wrong">
        <div style={state.errorPanel}>
          <AlertTriangleIcon size={17} />
          <span>{errorMsg}</span>
        </div>
        <button style={button.secondary(size.md)} onClick={() => setState("idle")}>
          Try again
        </button>
      </Screen>
    );
  }

  return (
    <Screen title="Connect sanad CLI">
      <p style={s.desc}>
        A device is requesting access to your sanad account. Confirm the code
        below matches what your terminal shows.
      </p>

      {code ? (
        <div style={s.codeBlock}>
          <span style={s.codeLabel}>Verification code</span>
          <code style={s.codeValue}>{code}</code>
        </div>
      ) : (
        <div style={state.warningPanel}>
          <AlertTriangleIcon size={17} />
          <span>
            No code found in the URL. Please use the complete link from your
            terminal (it ends with{" "}
            <code style={s.inlineCode}>?code=XXXX-XXXX</code>).
          </span>
        </div>
      )}

      <p style={s.desc}>
        Only approve if you just ran{" "}
        <code style={s.inlineCode}>sanad login</code> in your terminal. If you
        did not, choose Deny.
      </p>

      <div style={s.actions}>
        <button
          style={{
            ...button.primary(size.md),
            flex: 1,
            ...disabled(approveState === "loading" || !code),
          }}
          onClick={() => handleAction("approve")}
          disabled={approveState === "loading" || !code}
        >
          {approveState === "loading" ? "Processing…" : "Approve"}
        </button>
        <button
          style={{
            ...button.danger(size.md),
            flex: 1,
            ...disabled(approveState === "loading"),
          }}
          onClick={() => handleAction("deny")}
          disabled={approveState === "loading"}
        >
          <CrossOutlineIcon size={15} />
          Deny
        </button>
      </div>
    </Screen>
  );
}

function Screen({
  title,
  children,
}: {
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="pad-x" style={s.root}>
      <div style={s.card}>
        <SanadLogo height={40} />
        <h1 style={s.h1}>{title}</h1>
        {children}
      </div>
    </div>
  );
}

const s: Record<string, CSSProperties> = {
  root: {
    minHeight: "100vh",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "var(--paper)",
    padding: "2.5rem",
  },
  card: {
    ...surface.cardLifted,
    maxWidth: "460px",
    width: "100%",
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: "1.25rem",
  },
  h1: { ...type.h1, fontSize: "1.5rem" },
  desc: { ...type.body },
  inlineCode: {
    fontFamily: "var(--font-mono)",
    fontSize: "0.85em",
    background: "var(--paper-sunken)",
    border: "1px solid var(--rule)",
    borderRadius: "5px",
    padding: "0.05rem 0.35rem",
    color: "var(--ink)",
  },
  /* The focal point of the page: the code, set large in mono. */
  codeBlock: {
    width: "100%",
    background: "var(--paper-sunken)",
    border: "1px solid var(--rule)",
    borderRadius: "var(--radius-md)",
    padding: "1.25rem 1.4rem",
    display: "flex",
    flexDirection: "column",
    gap: "0.5rem",
    textAlign: "center",
  },
  codeLabel: {
    fontFamily: "var(--font-mono)",
    fontSize: "0.68rem",
    textTransform: "uppercase",
    letterSpacing: "0.16em",
    color: "var(--ink-muted)",
  },
  codeValue: {
    fontFamily: "var(--font-mono)",
    fontSize: "clamp(1.9rem, 8vw, 2.5rem)",
    fontWeight: 700,
    color: "var(--ink)",
    letterSpacing: "0.14em",
    lineHeight: 1.1,
  },
  actions: { display: "flex", gap: "0.75rem", width: "100%" },
};
