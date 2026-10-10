ALTER TABLE "users" ADD COLUMN "locale_chosen_at" timestamp with time zone;--> statement-breakpoint
-- A locale other than the default was picked by the member: keep it theirs.
UPDATE "users" SET "locale_chosen_at" = "updated_at" WHERE "locale" <> 'en';
