CREATE TABLE "bot_computer_backups" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"status" text NOT NULL,
	"reason" text NOT NULL,
	"store" text NOT NULL,
	"key_enc" text NOT NULL,
	"format" integer DEFAULT 1 NOT NULL,
	"driver" text NOT NULL,
	"source_ref" text NOT NULL,
	"bytes" bigint,
	"error" text,
	"restored_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "idx_bot_computer_backups_user" ON "bot_computer_backups" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_bot_computer_backups_running" ON "bot_computer_backups" USING btree ("user_id") WHERE "bot_computer_backups"."status" = 'running';