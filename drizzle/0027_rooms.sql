CREATE TABLE "conversation_participants" (
	"id" serial PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"added_by" text NOT NULL,
	"last_read_at" timestamp with time zone,
	"joined_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "author_user_id" text;--> statement-breakpoint
ALTER TABLE "conversation_participants" ADD CONSTRAINT "conversation_participants_session_id_bot_conversations_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."bot_conversations"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_participants" ADD CONSTRAINT "conversation_participants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_conversation_participants" ON "conversation_participants" USING btree ("session_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_conversation_participants_user" ON "conversation_participants" USING btree ("user_id");