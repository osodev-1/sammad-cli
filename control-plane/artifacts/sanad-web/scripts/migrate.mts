/**
 * Migration script — uses @neondatabase/serverless (HTTP) so it works
 * without a TCP-capable pg driver. Run with:
 *
 *   cd artifacts/sanad-web && pnpm run db:migrate-neon
 */
import { neon } from "@neondatabase/serverless";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const url = process.env.NEON_DATABASE_URL;
if (!url || !url.startsWith("postgresql://") && !url.startsWith("postgres://")) {
  console.error(
    "❌  NEON_DATABASE_URL must be a full connection string starting with postgresql://\n" +
    "    Find it in your Neon dashboard → Connect → Connection string."
  );
  process.exit(1);
}

const sql = neon(url);

// Read the generated migration SQL
const migrationPath = join(__dirname, "..", "drizzle", "0000_slim_kitty_pryde.sql");
const rawSql = readFileSync(migrationPath, "utf-8");

// drizzle-kit uses --> statement-breakpoint as a separator
const statements = rawSql
  .split("--> statement-breakpoint")
  .map((s) => s.trim())
  .filter(Boolean);

console.log(`Running ${statements.length} SQL statements against Neon…\n`);

for (let i = 0; i < statements.length; i++) {
  const stmt = statements[i];
  process.stdout.write(`  [${i + 1}/${statements.length}] ${stmt.slice(0, 60).replace(/\n/g, " ")}… `);
  try {
    await sql(stmt);
    console.log("✓");
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    // Ignore "already exists" errors — idempotent re-runs
    if (msg.includes("already exists") || msg.includes("duplicate")) {
      console.log("(already exists, skipped)");
    } else {
      console.error(`\n❌  Failed: ${msg}`);
      process.exit(1);
    }
  }
}

console.log("\n✅  Migration complete.");
