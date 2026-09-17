CREATE TABLE "coworker_dialogues" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"origin_session_id" text NOT NULL,
	"from_agent_id" text NOT NULL,
	"to_agent_id" text NOT NULL,
	"from_name" text NOT NULL,
	"to_name" text NOT NULL,
	"target_profile_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "coworker_rounds" (
	"id" text PRIMARY KEY NOT NULL,
	"dialogue_id" text NOT NULL,
	"round" integer NOT NULL,
	"message" text NOT NULL,
	"reply" text,
	"status" text DEFAULT 'running' NOT NULL,
	"child_session_id" text,
	"error" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "coworker_workspaces" (
	"agent_instance_id" text NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "coworkers" (
	"id" text PRIMARY KEY NOT NULL,
	"profile_key" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_memories" ADD COLUMN "agent_instance_id" text;--> statement-breakpoint
ALTER TABLE "coworker_dialogues" ADD CONSTRAINT "coworker_dialogues_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coworker_dialogues" ADD CONSTRAINT "coworker_dialogues_origin_session_id_sessions_id_fk" FOREIGN KEY ("origin_session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coworker_dialogues" ADD CONSTRAINT "coworker_dialogues_from_agent_id_coworkers_id_fk" FOREIGN KEY ("from_agent_id") REFERENCES "public"."coworkers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coworker_dialogues" ADD CONSTRAINT "coworker_dialogues_to_agent_id_coworkers_id_fk" FOREIGN KEY ("to_agent_id") REFERENCES "public"."coworkers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coworker_rounds" ADD CONSTRAINT "coworker_rounds_dialogue_id_coworker_dialogues_id_fk" FOREIGN KEY ("dialogue_id") REFERENCES "public"."coworker_dialogues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coworker_workspaces" ADD CONSTRAINT "coworker_workspaces_agent_instance_id_coworkers_id_fk" FOREIGN KEY ("agent_instance_id") REFERENCES "public"."coworkers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coworker_workspaces" ADD CONSTRAINT "coworker_workspaces_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coworker_workspaces" ADD CONSTRAINT "coworker_workspaces_workspace_id_agent_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."agent_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coworkers" ADD CONSTRAINT "coworkers_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "coworker_dialogues_origin" ON "coworker_dialogues" USING btree ("origin_session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "coworker_rounds_sequence" ON "coworker_rounds" USING btree ("dialogue_id","round");--> statement-breakpoint
CREATE UNIQUE INDEX "coworker_workspaces_identity" ON "coworker_workspaces" USING btree ("agent_instance_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "coworkers_identity" ON "coworkers" USING btree ("owner_user_id","profile_key");