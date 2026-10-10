CREATE TABLE "bot_process_watches" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"session_id" text NOT NULL,
	"bot_id" text NOT NULL,
	"job_id" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'watching' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bot_process_watches" ADD CONSTRAINT "bot_process_watches_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_process_watches" ADD CONSTRAINT "bot_process_watches_session_id_bot_conversations_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."bot_conversations"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_process_watches" ADD CONSTRAINT "bot_process_watches_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_bot_process_watches_job" ON "bot_process_watches" USING btree ("user_id","job_id");--> statement-breakpoint
CREATE INDEX "idx_bot_process_watches_watching" ON "bot_process_watches" USING btree ("user_id") WHERE "bot_process_watches"."status" = 'watching';