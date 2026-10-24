ALTER TABLE "drive_files" DROP CONSTRAINT "chk_drive_files_scope_owner";--> statement-breakpoint
ALTER TABLE "drive_folders" DROP CONSTRAINT "chk_drive_folders_scope_owner";--> statement-breakpoint
ALTER TABLE "drive_files" ADD COLUMN "owner_key" text;--> statement-breakpoint
ALTER TABLE "drive_folders" ADD COLUMN "owner_key" text;--> statement-breakpoint
CREATE INDEX "idx_drive_files_ext" ON "drive_files" USING btree ("scope","owner_key");--> statement-breakpoint
CREATE INDEX "idx_drive_folders_ext" ON "drive_folders" USING btree ("scope","owner_key");--> statement-breakpoint
ALTER TABLE "drive_files" ADD CONSTRAINT "chk_drive_files_scope_owner" CHECK ((
        ("drive_files"."scope" = 'kb' AND "drive_files"."base_id" IS NULL AND "drive_files"."owner_key" IS NULL AND "drive_files"."visibility" IS NOT NULL AND ("drive_files"."visibility" = 'team' OR "drive_files"."owner_user_id" IS NOT NULL))
        OR ("drive_files"."scope" = 'tables' AND "drive_files"."base_id" IS NOT NULL AND "drive_files"."owner_key" IS NULL AND "drive_files"."visibility" IS NULL AND "drive_files"."owner_user_id" IS NULL)
        OR ("drive_files"."scope" NOT IN ('kb', 'tables') AND "drive_files"."owner_key" IS NOT NULL AND "drive_files"."base_id" IS NULL AND "drive_files"."visibility" IS NULL AND "drive_files"."owner_user_id" IS NULL)
      ));--> statement-breakpoint
ALTER TABLE "drive_folders" ADD CONSTRAINT "chk_drive_folders_scope_owner" CHECK ((
        ("drive_folders"."scope" = 'kb' AND "drive_folders"."base_id" IS NULL AND "drive_folders"."owner_key" IS NULL AND "drive_folders"."visibility" IS NOT NULL AND ("drive_folders"."visibility" = 'team' OR "drive_folders"."owner_user_id" IS NOT NULL))
        OR ("drive_folders"."scope" = 'tables' AND "drive_folders"."base_id" IS NOT NULL AND "drive_folders"."owner_key" IS NULL AND "drive_folders"."visibility" IS NULL AND "drive_folders"."owner_user_id" IS NULL)
        OR ("drive_folders"."scope" NOT IN ('kb', 'tables') AND "drive_folders"."owner_key" IS NOT NULL AND "drive_folders"."base_id" IS NULL AND "drive_folders"."visibility" IS NULL AND "drive_folders"."owner_user_id" IS NULL)
      ));