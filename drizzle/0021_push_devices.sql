CREATE TABLE "push_devices" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token" text NOT NULL,
	"platform" text NOT NULL,
	"project_id" text NOT NULL,
	"client_ref" text,
	"prefs" text DEFAULT '{}' NOT NULL,
	"auth_version" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"disabled_at" timestamp with time zone,
	"disabled_reason" text
);
--> statement-breakpoint
ALTER TABLE "push_devices" ADD CONSTRAINT "push_devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_push_devices_token" ON "push_devices" USING btree ("token");--> statement-breakpoint
CREATE INDEX "idx_push_devices_user_active" ON "push_devices" USING btree ("user_id") WHERE "push_devices"."disabled_at" IS NULL;