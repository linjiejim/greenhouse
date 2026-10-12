-- A computer per Agent (spec 20261011-agent-first-class P3a, D28/D29). Every existing computer
-- becomes its member's main Agent's computer: its id is the member's user id, so container and
-- volume names, advisory-lock keys and labels stay valid. Watches and backups name their computer.
ALTER TABLE "bot_computers" ADD COLUMN "id" text;--> statement-breakpoint
UPDATE "bot_computers" SET "id" = "user_id";--> statement-breakpoint
ALTER TABLE "bot_computers" ALTER COLUMN "id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_computers" DROP CONSTRAINT "bot_computers_pkey";--> statement-breakpoint
ALTER TABLE "bot_computers" ADD PRIMARY KEY ("id");--> statement-breakpoint
ALTER TABLE "bot_computers" ADD COLUMN "bot_id" text;--> statement-breakpoint
CREATE INDEX "idx_bot_computers_user" ON "bot_computers" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "bot_computer_backups" ADD COLUMN "computer_id" text;--> statement-breakpoint
UPDATE "bot_computer_backups" SET "computer_id" = "user_id";--> statement-breakpoint
ALTER TABLE "bot_computer_backups" ALTER COLUMN "computer_id" SET NOT NULL;--> statement-breakpoint
DROP INDEX "uq_bot_computer_backups_running";--> statement-breakpoint
CREATE UNIQUE INDEX "uq_bot_computer_backups_running" ON "bot_computer_backups" USING btree ("computer_id") WHERE "bot_computer_backups"."status" = 'running';--> statement-breakpoint
CREATE INDEX "idx_bot_computer_backups_computer" ON "bot_computer_backups" USING btree ("computer_id","created_at");--> statement-breakpoint
ALTER TABLE "bot_process_watches" ADD COLUMN "computer_id" text;--> statement-breakpoint
UPDATE "bot_process_watches" SET "computer_id" = "user_id";--> statement-breakpoint
ALTER TABLE "bot_process_watches" ALTER COLUMN "computer_id" SET NOT NULL;--> statement-breakpoint
DROP INDEX "uq_bot_process_watches_job";--> statement-breakpoint
CREATE UNIQUE INDEX "uq_bot_process_watches_job" ON "bot_process_watches" USING btree ("computer_id","job_id");
