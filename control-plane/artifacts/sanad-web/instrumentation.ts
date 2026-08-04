/**
 * Next.js instrumentation — runs once when the Node server process boots.
 *
 * On Railway (RUN_MIGRATIONS=true) it applies pending database migrations
 * before the app serves traffic. Gated so local and CI image builds — which
 * point at a throwaway DATABASE_URL — never attempt to migrate. If a migration
 * fails, this throws and the deployment fails its health check, leaving the
 * previous (working) deployment serving — a safe, loud failure.
 */
export async function register(): Promise<void> {
  if (
    process.env.NEXT_RUNTIME === "nodejs" &&
    process.env.RUN_MIGRATIONS === "true"
  ) {
    const { runMigrations } = await import("./lib/db/migrate");
    await runMigrations();
    console.log("[instrumentation] database migrations applied");
  }
}
