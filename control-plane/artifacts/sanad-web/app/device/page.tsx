import { Suspense } from "react";
import type { CSSProperties } from "react";
import { surface, type } from "../ui/theme";
import SanadLogo from "../ui/SanadLogo";
import DevicePageContent from "./DevicePageContent";

export default function DevicePage() {
  return (
    <Suspense fallback={<Loading />}>
      <DevicePageContent />
    </Suspense>
  );
}

function Loading() {
  return (
    <div className="pad-x" style={styles.root}>
      <div style={styles.card}>
        <SanadLogo height={40} />
        <p style={styles.p}>Loading…</p>
      </div>
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
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
    gap: "1rem",
  },
  p: { ...type.body },
};
