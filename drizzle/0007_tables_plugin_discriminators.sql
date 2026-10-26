-- Plugin ownership moves in metadata only; existing rows and Tables DDL stay intact.
ALTER TABLE "shares" DROP CONSTRAINT IF EXISTS "chk_shares_resource";
--> statement-breakpoint
ALTER TABLE "file_links" DROP CONSTRAINT IF EXISTS "chk_file_links_target";
--> statement-breakpoint
ALTER TABLE "folders" DROP CONSTRAINT IF EXISTS "chk_folders_scope_owner";
--> statement-breakpoint
ALTER TABLE "runs" DROP CONSTRAINT IF EXISTS "chk_runs_kind";
--> statement-breakpoint
ALTER TABLE "files" DROP CONSTRAINT IF EXISTS "chk_files_source_owner";
--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "chk_files_source_owner" CHECK (
 (source = 'drive' AND scope IS NOT NULL AND storage_key IS NOT NULL AND session_id IS NULL AND run_id IS NULL)
 OR (source IN ('chat_upload','chat_output') AND session_id IS NOT NULL AND storage_key IS NOT NULL AND scope IS NULL AND folder_id IS NULL)
 OR (source = 'run' AND run_id IS NOT NULL AND scope IS NULL AND folder_id IS NULL AND session_id IS NULL)
);
