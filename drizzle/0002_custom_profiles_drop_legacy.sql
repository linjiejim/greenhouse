--> Backfill the new `data` jsonb from the legacy columns before enforcing NOT
--> NULL and dropping them. No-op on a fresh/empty table (e.g. CI/test build).
UPDATE "custom_profiles" SET "data" = jsonb_build_object(
	'description', "description",
	'system_prompt', "system_prompt",
	'tools', "tools"::jsonb,
	'capabilities', "capabilities"::jsonb,
	'max_steps', "max_steps",
	'tool_choice', 'auto',
	'avatar', "avatar"::jsonb
) WHERE "data" IS NULL;--> statement-breakpoint
ALTER TABLE "custom_profiles" ALTER COLUMN "data" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "custom_profiles" DROP COLUMN "description";--> statement-breakpoint
ALTER TABLE "custom_profiles" DROP COLUMN "tools";--> statement-breakpoint
ALTER TABLE "custom_profiles" DROP COLUMN "system_prompt";--> statement-breakpoint
ALTER TABLE "custom_profiles" DROP COLUMN "capabilities";--> statement-breakpoint
ALTER TABLE "custom_profiles" DROP COLUMN "max_steps";--> statement-breakpoint
ALTER TABLE "custom_profiles" DROP COLUMN "avatar";