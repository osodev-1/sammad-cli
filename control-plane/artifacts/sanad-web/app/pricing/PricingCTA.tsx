"use client";

import { useState } from "react";
import Link from "next/link";
import { SignInButton } from "@clerk/nextjs";
import { AlertTriangleIcon } from "../ui/icons";
import { button, disabled, size, state } from "../ui/theme";

interface Props {
  plan: string;
  cta: string;
  isHighlight: boolean;
  isSignedIn: boolean;
  currentPlan?: string;
}

export default function PricingCTA({
  plan,
  cta,
  isHighlight,
  isSignedIn,
  currentPlan,
}: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const base = isHighlight ? button.primary(size.md) : button.secondary(size.md);
  const style: React.CSSProperties = {
    ...base,
    width: "100%",
    marginTop: "auto",
    boxSizing: "border-box",
  };

  // Not signed in — gate every tier behind sign-in.
  if (!isSignedIn) {
    return (
      <SignInButton mode="modal">
        <button style={style}>{cta}</button>
      </SignInButton>
    );
  }

  // Free plan — just go to dashboard
  if (plan === "Free") {
    return (
      <Link href="/dashboard" style={style}>
        {cta}
      </Link>
    );
  }

  // Already on this plan
  if (
    (currentPlan === "pro" && plan === "Pro") ||
    (currentPlan === "team" && plan === "Team")
  ) {
    return (
      <span
        style={{
          ...button.secondary(size.md),
          width: "100%",
          marginTop: "auto",
          boxSizing: "border-box",
          cursor: "default",
          color: "var(--ink-muted)",
          borderStyle: "dashed",
        }}
      >
        Current plan
      </span>
    );
  }

  async function handleUpgrade() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan: plan.toLowerCase() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to start checkout");
        return;
      }
      window.location.href = data.url;
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ marginTop: "auto" }}>
      <button
        style={{ ...style, ...disabled(loading) }}
        onClick={handleUpgrade}
        disabled={loading}
      >
        {loading ? "Redirecting…" : cta}
      </button>
      {error && (
        <div style={{ ...state.errorPanel, marginTop: "0.75rem", fontSize: "0.8rem" }}>
          <AlertTriangleIcon size={16} />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}
