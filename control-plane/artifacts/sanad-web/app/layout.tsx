import type { Metadata } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import "./globals.css";

export const metadata: Metadata = {
  title: "sanad — governed AI coding agent",
  description:
    "sanad routes every model call through a governed gateway. Sign in to manage your subscription and CLI sessions.",
};

/**
 * Clerk's widgets are themed to match "Printed Terminal" so the avatar,
 * sign-in modal and account menu stay inside the monochrome palette.
 */
const clerkAppearance = {
  variables: {
    colorPrimary: "#0a0a0a",
    colorText: "#0a0a0a",
    colorTextSecondary: "#6b6b6b",
    colorBackground: "#ffffff",
    colorInputBackground: "#ffffff",
    colorInputText: "#0a0a0a",
    colorDanger: "#0a0a0a",
    colorSuccess: "#0a0a0a",
    colorWarning: "#0a0a0a",
    colorNeutral: "#0a0a0a",
    /*
     * Clerk derives EVERY surface radius from this one value — cards, popovers
     * and inputs included. It must stay a true corner radius: a pill value here
     * rounds the sign-in card into a circle that clips its own contents.
     * Pills are applied per-element below, where they belong.
     */
    borderRadius: "12px",
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", system-ui, sans-serif',
  },
  elements: {
    /* Containers: hairline rule + soft lift, matching our cards. */
    card: {
      borderRadius: "var(--radius-lg)",
      border: "1px solid var(--rule)",
      boxShadow: "var(--shadow-soft)",
    },
    modalContent: { borderRadius: "var(--radius-lg)" },
    userButtonPopoverCard: {
      borderRadius: "var(--radius-lg)",
      border: "1px solid var(--rule)",
      boxShadow: "var(--shadow-soft)",
    },
    userProfile: { borderRadius: "var(--radius-lg)" },

    /* Fields read as rectangles, like the rest of the site. */
    formFieldInput: { borderRadius: "var(--radius-md)" },

    /* Pills are reserved for actions — this is the one place they belong. */
    formButtonPrimary: { borderRadius: "var(--radius-pill)" },
    socialButtonsBlockButton: { borderRadius: "var(--radius-pill)" },

    avatarBox: { border: "1px solid var(--rule-strong)" },
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <ClerkProvider appearance={clerkAppearance}>
      <html lang="en">
        <body>{children}</body>
      </html>
    </ClerkProvider>
  );
}
