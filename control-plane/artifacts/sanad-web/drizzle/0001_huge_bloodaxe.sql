CREATE TABLE "terminal_tickets" (
	"id" text PRIMARY KEY NOT NULL,
	"ticket_hash" text NOT NULL,
	"session_token" text,
	"user_id" text NOT NULL,
	"org_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"redeemed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "terminal_tickets_ticket_hash_unique" UNIQUE("ticket_hash")
);
--> statement-breakpoint
ALTER TABLE "terminal_tickets" ADD CONSTRAINT "terminal_tickets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terminal_tickets" ADD CONSTRAINT "terminal_tickets_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;