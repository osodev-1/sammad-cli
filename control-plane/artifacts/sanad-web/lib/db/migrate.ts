import fs from "node:fs";
import path from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db } from "./index";

/**
 * Locate the migrations folder at runtime. Next's standalone `server.js` does
 * `chdir(__dirname)`, so cwd is the server directory (…/artifacts/sanad-web),
 * next to which the Dockerfile copies the drizzle/ folder. Probe a few
 * candidates and use whichever actually contains the journal, so a layout
 * change can't silently break migrations.
 */
function resolveMigrationsFolder(): string {
  const candidates = [
    path.join(process.cwd(), "drizzle"),
    path.join(process.cwd(), "artifacts/sanad-web/drizzle"),
    "/app/artifacts/sanad-web/drizzle",
  ];
  const found = candidates.find((c) =>
    fs.existsSync(path.join(c, "meta", "_journal.json"))
  );
  if (!found) {
    throw new Error(
      `drizzle migrations folder not found (tried: ${candidates.join(", ")})`
    );
  }
  return found;
}

/**
 * Apply pending Drizzle migrations against the app's Postgres pool. Runs from
 * the instrumentation hook on server startup — inside Railway, where
 * DATABASE_URL reaches the private database.
 */
export async function runMigrations(): Promise<void> {
  await migrate(db, { migrationsFolder: resolveMigrationsFolder() });
}
