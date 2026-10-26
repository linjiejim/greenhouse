CREATE TABLE IF NOT EXISTS "email_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"email_address" text NOT NULL,
	"display_name" text,
	"preset" text DEFAULT 'custom' NOT NULL,
	"imap_host" text NOT NULL,
	"imap_port" integer NOT NULL,
	"smtp_host" text NOT NULL,
	"smtp_port" integer NOT NULL,
	"use_tls" boolean DEFAULT true NOT NULL,
	"use_proxy" boolean DEFAULT false NOT NULL,
	"username" text NOT NULL,
	"password_enc" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"error_message" text,
	"last_verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_email_accounts_user_address" UNIQUE("user_id","email_address"),
	CONSTRAINT "chk_email_accounts_preset" CHECK ("email_accounts"."preset" IN ('feishu', 'exmail', 'gmail', 'qq', '163', 'custom')),
	CONSTRAINT "chk_email_accounts_status" CHECK ("email_accounts"."status" IN ('active', 'disabled', 'error'))
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "email_accounts" ADD CONSTRAINT "email_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_email_accounts_user" ON "email_accounts" USING btree ("user_id");
