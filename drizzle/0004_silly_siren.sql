CREATE TABLE "agent_skill_versions" (
	"id" serial PRIMARY KEY NOT NULL,
	"skill_id" integer NOT NULL,
	"version" text NOT NULL,
	"changelog" text NOT NULL,
	"file_count" integer NOT NULL,
	"size_bytes" integer NOT NULL,
	"content_hash" text NOT NULL,
	"storage_key" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_skills" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"display_name" text NOT NULL,
	"description" text NOT NULL,
	"tags" text DEFAULT '[]' NOT NULL,
	"latest_version" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"owner_user_id" text NOT NULL,
	"download_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_skill_versions" ADD CONSTRAINT "agent_skill_versions_skill_id_agent_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."agent_skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_agent_skill_versions_skill_version" ON "agent_skill_versions" USING btree ("skill_id","version");--> statement-breakpoint
CREATE INDEX "idx_agent_skill_versions_skill" ON "agent_skill_versions" USING btree ("skill_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_agent_skills_name" ON "agent_skills" USING btree ("name");--> statement-breakpoint
CREATE INDEX "idx_agent_skills_status" ON "agent_skills" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_agent_skills_updated_at" ON "agent_skills" USING btree ("updated_at");