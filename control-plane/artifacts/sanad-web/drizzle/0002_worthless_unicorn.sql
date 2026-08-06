CREATE TABLE "ships" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"org_id" text NOT NULL,
	"app_slug" text NOT NULL,
	"ecr_image" text,
	"commit_sha" text NOT NULL,
	"codebuild_id" text,
	"status" text NOT NULL,
	"url" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "ships_app_slug_unique" UNIQUE("app_slug")
);
--> statement-breakpoint
CREATE TABLE "workspace_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
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
	CONSTRAINT "workspace_tasks_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "workspace_tasks_hash12_unique" UNIQUE("hash12")
);
--> statement-breakpoint
ALTER TABLE "ships" ADD CONSTRAINT "ships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ships" ADD CONSTRAINT "ships_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_tasks" ADD CONSTRAINT "workspace_tasks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;