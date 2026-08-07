CREATE TABLE "workspace_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"hash12" text NOT NULL,
	"efs_access_point_id" text NOT NULL,
	"task_arn" text,
	"task_ip" text,
	"run_nonce" text,
	"image_ref" text NOT NULL,
	"state" text NOT NULL,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_sessions_hash12_unique" UNIQUE("hash12")
);
--> statement-breakpoint
ALTER TABLE "workspace_sessions" ADD CONSTRAINT "workspace_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
INSERT INTO "workspace_sessions" ("id", "user_id", "name", "hash12", "efs_access_point_id", "task_arn", "task_ip", "run_nonce", "image_ref", "state", "last_seen_at", "created_at", "updated_at")
SELECT 'main_' || "user_id", "user_id", 'main', "hash12", "efs_access_point_id", "task_arn", "task_ip", "run_nonce", "image_ref", "state", "last_seen_at", "created_at", "updated_at"
FROM "workspace_tasks"
ON CONFLICT ("hash12") DO NOTHING;
