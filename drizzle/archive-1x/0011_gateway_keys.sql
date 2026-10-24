CREATE TABLE "gateway_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"key_hash" text NOT NULL,
	"key_prefix" text NOT NULL,
	"allowed_models" text,
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "llm_usage" ADD COLUMN "gateway_key_id" text;--> statement-breakpoint
ALTER TABLE "gateway_keys" ADD CONSTRAINT "gateway_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_gateway_keys_hash" ON "gateway_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "idx_gateway_keys_user" ON "gateway_keys" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_llm_usage_gateway_key" ON "llm_usage" USING btree ("gateway_key_id","created_at");