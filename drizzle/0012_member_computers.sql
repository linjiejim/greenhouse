CREATE TABLE "member_computers" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"provider" text DEFAULT 'e2b' NOT NULL,
	"sandbox_id" text,
	"status" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone NOT NULL,
	"stopped_at" timestamp with time zone,
	"stop_reason" text,
	"minutes_billed" integer DEFAULT 0 NOT NULL,
	"budget_key" text,
	"block_started_at" timestamp with time zone,
	"client" text NOT NULL,
	"oauth_client_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "member_computers" ADD CONSTRAINT "member_computers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_member_computers_active_user" ON "member_computers" USING btree ("user_id") WHERE "member_computers"."status" IN ('starting', 'running', 'stopping');--> statement-breakpoint
CREATE INDEX "idx_member_computers_status" ON "member_computers" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_member_computers_user_started" ON "member_computers" USING btree ("user_id","started_at");