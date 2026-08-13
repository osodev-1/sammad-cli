CREATE TABLE "workspace_machines" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"env" text NOT NULL,
	"hash12" text NOT NULL,
	"efs_access_point_id" text NOT NULL,
	"task_arn" text,
	"task_ip" text,
	"run_nonce" text,
	"image_ref" text NOT NULL,
	"state" text NOT NULL,
	"keep_warm" boolean DEFAULT false NOT NULL,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_machines_hash12_unique" UNIQUE("hash12")
);
--> statement-breakpoint
ALTER TABLE "workspace_machines" ADD CONSTRAINT "workspace_machines_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;