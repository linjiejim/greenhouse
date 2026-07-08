CREATE TABLE "workspace_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb,
	"value_enc" text,
	"updated_by" text,
	"updated_at" timestamp with time zone NOT NULL
);
