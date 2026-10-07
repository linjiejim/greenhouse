-- Bots are private to their owner (2026-10-08): the reviewed sharing lifecycle,
-- clone lineage and governance metadata that 0010 carried over from the retired
-- custom_profiles tables are dropped. Versions stay (bot_versions keeps the
-- executable manifests that pinned bot:<id>@<v> references resolve to).
ALTER TABLE "bots" DROP CONSTRAINT "bots_owner_backup_user_id_users_id_fk";
--> statement-breakpoint
DROP INDEX "idx_bots_shared";--> statement-breakpoint
DROP INDEX "idx_bots_backup_owner";--> statement-breakpoint
ALTER TABLE "bot_versions" DROP COLUMN "purpose";--> statement-breakpoint
ALTER TABLE "bot_versions" DROP COLUMN "audience";--> statement-breakpoint
ALTER TABLE "bot_versions" DROP COLUMN "risk_level";--> statement-breakpoint
ALTER TABLE "bot_versions" DROP COLUMN "budget_policy";--> statement-breakpoint
ALTER TABLE "bot_versions" DROP COLUMN "eval_refs";--> statement-breakpoint
ALTER TABLE "bot_versions" DROP COLUMN "owner_backup_user_id";--> statement-breakpoint
ALTER TABLE "bot_versions" DROP COLUMN "review_due_at";--> statement-breakpoint
ALTER TABLE "bots" DROP COLUMN "is_shared";--> statement-breakpoint
ALTER TABLE "bots" DROP COLUMN "lifecycle_status";--> statement-breakpoint
ALTER TABLE "bots" DROP COLUMN "lifecycle_note";--> statement-breakpoint
ALTER TABLE "bots" DROP COLUMN "published_version";--> statement-breakpoint
ALTER TABLE "bots" DROP COLUMN "owner_backup_user_id";--> statement-breakpoint
ALTER TABLE "bots" DROP COLUMN "reviewed_by";--> statement-breakpoint
ALTER TABLE "bots" DROP COLUMN "reviewed_at";--> statement-breakpoint
ALTER TABLE "bots" DROP COLUMN "next_review_at";--> statement-breakpoint
ALTER TABLE "bots" DROP COLUMN "forked_from";