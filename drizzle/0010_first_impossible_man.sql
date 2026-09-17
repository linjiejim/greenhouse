CREATE TABLE "coworker_inboxes" (
	"user_id" text NOT NULL,
	"agent_instance_id" text NOT NULL,
	"active_session_id" text,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "coworker_message_reads" (
	"user_id" text NOT NULL,
	"message_id" text NOT NULL,
	"content_hash" text NOT NULL,
	"read_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "coworker_inboxes" ADD CONSTRAINT "coworker_inboxes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coworker_inboxes" ADD CONSTRAINT "coworker_inboxes_agent_instance_id_coworkers_id_fk" FOREIGN KEY ("agent_instance_id") REFERENCES "public"."coworkers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coworker_inboxes" ADD CONSTRAINT "coworker_inboxes_active_session_id_sessions_id_fk" FOREIGN KEY ("active_session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coworker_message_reads" ADD CONSTRAINT "coworker_message_reads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coworker_message_reads" ADD CONSTRAINT "coworker_message_reads_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "coworker_inboxes_identity" ON "coworker_inboxes" USING btree ("user_id","agent_instance_id");--> statement-breakpoint
CREATE UNIQUE INDEX "coworker_message_reads_identity" ON "coworker_message_reads" USING btree ("user_id","message_id");
--> statement-breakpoint
-- Backfill stable identities without rewriting any transcript or pinned version.
INSERT INTO coworkers (id, profile_key, owner_user_id, name, created_at)
SELECT gen_random_uuid()::text, 'custom:' || id, user_id, name, now() FROM custom_profiles
ON CONFLICT (owner_user_id, profile_key) DO NOTHING;
--> statement-breakpoint
INSERT INTO coworkers (id, profile_key, owner_user_id, name, created_at)
SELECT gen_random_uuid()::text, 'sprouty', id, 'Sprouty', now() FROM users
WHERE role IN ('super', 'team') ON CONFLICT (owner_user_id, profile_key) DO NOTHING;
--> statement-breakpoint
UPDATE sessions s SET agent_instance_id = c.id FROM coworkers c
WHERE s.agent_instance_id IS NULL AND s.user_id IS NOT NULL
AND s.channel NOT IN ('subagent', 'workflow')
AND ((c.profile_key LIKE 'custom:%' AND c.profile_key = regexp_replace(s.profile_id, '@[0-9]+$', ''))
OR (c.profile_key = 'sprouty' AND c.owner_user_id = s.user_id AND s.profile_id IN
('sprouty', 'sprouty-quick', 'sprouty-deep', 'sprouty-k3', 'sprouty-workflows', 'sprouty-mission',
 'workflow-planner', 'sprouty-agents', 'team', 'eval-judge', 'default', 'desktop', 'local-pi',
 'local-dev', 'researcher', 'writer', 'project-assistant')));
--> statement-breakpoint
-- Establish the upgrade baseline: historical replies do not all become new mail.
INSERT INTO coworker_message_reads (user_id, message_id, content_hash, read_at)
SELECT s.user_id, m.id, md5(m.content || m.pipeline), now()
FROM messages m JOIN sessions s ON s.id = m.session_id JOIN users u ON u.id = s.user_id
WHERE m.role = 'assistant' AND s.channel NOT IN ('subagent', 'workflow')
ON CONFLICT (user_id, message_id) DO NOTHING;
