-- Adopt existing 3.0 tables without moving or deleting data.
CREATE TABLE IF NOT EXISTS "project_members" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"added_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_project_members_role" CHECK ("project_members"."role" IN ('owner', 'member'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'planning' NOT NULL,
	"priority" text DEFAULT 'normal' NOT NULL,
	"owner_id" text NOT NULL,
	"start_date" date,
	"end_date" date,
	"color" text,
	"visibility" text DEFAULT 'public' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_projects_status" CHECK ("projects"."status" IN ('planning', 'active', 'on_hold', 'completed', 'archived')),
	CONSTRAINT "chk_projects_priority" CHECK ("projects"."priority" IN ('low', 'normal', 'high', 'urgent')),
	CONSTRAINT "chk_projects_visibility" CHECK ("projects"."visibility" IN ('public', 'private'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "task_comments" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"user_id" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"parent_id" text,
	"title" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'todo' NOT NULL,
	"priority" text DEFAULT 'normal' NOT NULL,
	"task_type" text DEFAULT 'task' NOT NULL,
	"assignee_id" text,
	"start_date" date,
	"due_date" date,
	"completed_at" timestamp with time zone,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"estimated_hours" integer,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"dependencies" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_tasks_status" CHECK ("tasks"."status" IN ('todo', 'in_progress', 'in_review', 'done', 'cancelled')),
	CONSTRAINT "chk_tasks_priority" CHECK ("tasks"."priority" IN ('low', 'normal', 'high', 'urgent'))
);
--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'project_members_project_id_projects_id_fk' AND conrelid = 'project_members'::regclass) THEN
  ALTER TABLE "project_members" ADD CONSTRAINT "project_members_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'task_comments_task_id_tasks_id_fk' AND conrelid = 'task_comments'::regclass) THEN
  ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tasks_project_id_projects_id_fk' AND conrelid = 'tasks'::regclass) THEN
  ALTER TABLE "tasks" ADD CONSTRAINT "tasks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tasks_parent_id_tasks_id_fk' AND conrelid = 'tasks'::regclass) THEN
  ALTER TABLE "tasks" ADD CONSTRAINT "tasks_parent_id_tasks_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_project_members_project_user" ON "project_members" USING btree ("project_id","user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_project_members_user" ON "project_members" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_projects_status" ON "projects" USING btree ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_projects_owner" ON "projects" USING btree ("owner_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_task_comments_task" ON "task_comments" USING btree ("task_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_tasks_project" ON "tasks" USING btree ("project_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_tasks_parent" ON "tasks" USING btree ("parent_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_tasks_assignee" ON "tasks" USING btree ("assignee_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_tasks_status" ON "tasks" USING btree ("status");
