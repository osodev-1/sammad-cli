-- Online-safe: bound the lock wait so a busy usage_events table can never turn
-- this into a hang that queues live gateway writes behind it. If a conflicting
-- lock is held, the migration fails fast (retryable) instead of blocking prod.
SET lock_timeout = '5s';
--> statement-breakpoint
-- Nullable, no default → a metadata-only change in Postgres, not a table rewrite.
ALTER TABLE "cli_sessions" ADD COLUMN "project_id" text;
--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN "project_id" text;
