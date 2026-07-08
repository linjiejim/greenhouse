CREATE TABLE "im_bots" (
	"id" text PRIMARY KEY NOT NULL,
	"channel" text DEFAULT 'telegram' NOT NULL,
	"name" text NOT NULL,
	"token_enc" text NOT NULL,
	"bot_username" text,
	"default_profile_id" text DEFAULT 'default' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"poll_offset" integer DEFAULT 0 NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "im_identities" (
	"id" text PRIMARY KEY NOT NULL,
	"bot_id" text NOT NULL,
	"channel" text DEFAULT 'telegram' NOT NULL,
	"ext_user_id" text NOT NULL,
	"ext_chat_id" text NOT NULL,
	"user_id" text NOT NULL,
	"session_id" text,
	"display_name" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "im_pairing_codes" (
	"code" text PRIMARY KEY NOT NULL,
	"bot_id" text NOT NULL,
	"user_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "im_identities" ADD CONSTRAINT "im_identities_bot_id_im_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."im_bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "im_pairing_codes" ADD CONSTRAINT "im_pairing_codes_bot_id_im_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."im_bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_im_bots_status" ON "im_bots" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_im_identities_bot_user" ON "im_identities" USING btree ("bot_id","ext_user_id");--> statement-breakpoint
CREATE INDEX "idx_im_identities_user" ON "im_identities" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_im_pairing_expires" ON "im_pairing_codes" USING btree ("expires_at");