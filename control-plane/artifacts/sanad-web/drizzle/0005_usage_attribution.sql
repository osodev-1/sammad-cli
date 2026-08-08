ALTER TABLE "cli_sessions" ADD COLUMN "project_id" text;
--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN "project_id" text;
--> statement-breakpoint
CREATE INDEX "usage_events_project_idx" ON "usage_events" ("project_id");
