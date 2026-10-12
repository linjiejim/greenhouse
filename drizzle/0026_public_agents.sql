CREATE TABLE "bot_feedback" (
	"id" serial PRIMARY KEY NOT NULL,
	"bot_id" text NOT NULL,
	"user_id" text NOT NULL,
	"session_id" text NOT NULL,
	"message_id" text NOT NULL,
	"rating" integer NOT NULL,
	"comment" text DEFAULT '' NOT NULL,
	"version" integer,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
DROP INDEX "uq_bot_conversations_owner_bot";--> statement-breakpoint
ALTER TABLE "platform_audit_events" ADD COLUMN "requested_by_user_id" text;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "visibility" text DEFAULT 'private' NOT NULL;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "published_version" integer;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "public_paused" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "publication" text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_feedback" ADD CONSTRAINT "bot_feedback_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_feedback" ADD CONSTRAINT "bot_feedback_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_bot_feedback_message" ON "bot_feedback" USING btree ("user_id","message_id");--> statement-breakpoint
CREATE INDEX "idx_bot_feedback_bot" ON "bot_feedback" USING btree ("bot_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_bots_public" ON "bots" USING btree ("visibility") WHERE "bots"."visibility" = 'public';--> statement-breakpoint
CREATE UNIQUE INDEX "uq_bot_conversations_owner_bot" ON "bot_conversations" USING btree ("user_id","owner_bot_id") WHERE "bot_conversations"."kind" = 'direct';