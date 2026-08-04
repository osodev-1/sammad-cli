import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@neondatabase/serverless"],
  // `next build` and `next dev` share .next by default, so building while the
  // dev server is up overwrites the chunks it is still serving. The browser
  // then 404s on its own JS and rejects with a non-Error event object — which
  // surfaces as an unexplained "runtime error" that looks like an app bug.
  // `build:check` sets this so verification builds land somewhere harmless.
  // Unset (Vercel, CI) it stays .next, so deploys are unaffected. The name is
  // project-scoped so a generic env var on the deploy platform can't silently
  // redirect a production build's output.
  distDir: process.env.SANAD_NEXT_BUILD_DIR || ".next",
  // Re-expose the server-side secret as a NEXT_PUBLIC_ var so ClerkProvider
  // can read it in the browser bundle without requiring the user to set
  // two separate secrets.
  env: {
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY:
      process.env.CLERK_PUBLISHABLE_KEY ?? "",
  },
};

export default nextConfig;
