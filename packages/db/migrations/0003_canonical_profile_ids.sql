ALTER TABLE "conversations" ALTER COLUMN "profile_id" SET DEFAULT 'sprouty';--> statement-breakpoint
ALTER TABLE "automations" ALTER COLUMN "profile_id" SET DEFAULT 'sprouty';--> statement-breakpoint
ALTER TABLE "run_profiles" ALTER COLUMN "base_profile_id" SET DEFAULT 'sprouty';--> statement-breakpoint

-- Profile ids: every stored id is canonical, so readers take it as it is.
-- Retired presets and the 1.x team ids become sprouty; the retired local
-- runtimes become desktop. The list matches normalizeProfileId(), which now
-- maps request input only. Below the column defaults this is data only: no
-- row matches on a fresh install or on a second run.

-- Conversations, Automations and usage history.
UPDATE "conversations" AS "t"
SET "profile_id" = "m"."canonical"
FROM (VALUES
  ('sprouty-quick', 'sprouty'),
  ('sprouty-deep', 'sprouty'),
  ('sprouty-k3', 'sprouty'),
  ('sprouty-workflows', 'sprouty'),
  ('workflow-planner', 'sprouty'),
  ('sprouty-agents', 'sprouty'),
  ('sprouty-mission', 'sprouty'),
  ('eval-judge', 'sprouty'),
  ('team', 'sprouty'),
  ('default', 'sprouty'),
  ('researcher', 'sprouty'),
  ('writer', 'sprouty'),
  ('project-assistant', 'sprouty'),
  ('cs-quality', 'sprouty'),
  ('ops-analyst', 'sprouty'),
  ('cc-analyzer', 'sprouty'),
  ('crm', 'sprouty'),
  ('local-dev', 'desktop'),
  ('local-pi', 'desktop')
) AS "m"("legacy", "canonical")
WHERE "t"."profile_id" = "m"."legacy";
--> statement-breakpoint

UPDATE "automations" AS "t"
SET "profile_id" = "m"."canonical"
FROM (VALUES
  ('sprouty-quick', 'sprouty'),
  ('sprouty-deep', 'sprouty'),
  ('sprouty-k3', 'sprouty'),
  ('sprouty-workflows', 'sprouty'),
  ('workflow-planner', 'sprouty'),
  ('sprouty-agents', 'sprouty'),
  ('sprouty-mission', 'sprouty'),
  ('eval-judge', 'sprouty'),
  ('team', 'sprouty'),
  ('default', 'sprouty'),
  ('researcher', 'sprouty'),
  ('writer', 'sprouty'),
  ('project-assistant', 'sprouty'),
  ('cs-quality', 'sprouty'),
  ('ops-analyst', 'sprouty'),
  ('cc-analyzer', 'sprouty'),
  ('crm', 'sprouty'),
  ('local-dev', 'desktop'),
  ('local-pi', 'desktop')
) AS "m"("legacy", "canonical")
WHERE "t"."profile_id" = "m"."legacy";
--> statement-breakpoint

UPDATE "usage_events" AS "t"
SET "profile_id" = "m"."canonical"
FROM (VALUES
  ('sprouty-quick', 'sprouty'),
  ('sprouty-deep', 'sprouty'),
  ('sprouty-k3', 'sprouty'),
  ('sprouty-workflows', 'sprouty'),
  ('workflow-planner', 'sprouty'),
  ('sprouty-agents', 'sprouty'),
  ('sprouty-mission', 'sprouty'),
  ('eval-judge', 'sprouty'),
  ('team', 'sprouty'),
  ('default', 'sprouty'),
  ('researcher', 'sprouty'),
  ('writer', 'sprouty'),
  ('project-assistant', 'sprouty'),
  ('cs-quality', 'sprouty'),
  ('ops-analyst', 'sprouty'),
  ('cc-analyzer', 'sprouty'),
  ('crm', 'sprouty'),
  ('local-dev', 'desktop'),
  ('local-pi', 'desktop')
) AS "m"("legacy", "canonical")
WHERE "t"."profile_id" = "m"."legacy";
--> statement-breakpoint

-- Custom Agents: sprouty is the only base; any other stored base already ran as sprouty.
UPDATE "run_profiles" SET "base_profile_id" = 'sprouty' WHERE "base_profile_id" <> 'sprouty';
--> statement-breakpoint

-- Automation run snapshots: the task copy must keep matching the Automation row.
UPDATE "runs" AS "t"
SET "input" = jsonb_set("t"."input", '{task,profile_id}', to_jsonb("m"."canonical"))
FROM (VALUES
  ('sprouty-quick', 'sprouty'),
  ('sprouty-deep', 'sprouty'),
  ('sprouty-k3', 'sprouty'),
  ('sprouty-workflows', 'sprouty'),
  ('workflow-planner', 'sprouty'),
  ('sprouty-agents', 'sprouty'),
  ('sprouty-mission', 'sprouty'),
  ('eval-judge', 'sprouty'),
  ('team', 'sprouty'),
  ('default', 'sprouty'),
  ('researcher', 'sprouty'),
  ('writer', 'sprouty'),
  ('project-assistant', 'sprouty'),
  ('cs-quality', 'sprouty'),
  ('ops-analyst', 'sprouty'),
  ('cc-analyzer', 'sprouty'),
  ('crm', 'sprouty'),
  ('local-dev', 'desktop'),
  ('local-pi', 'desktop')
) AS "m"("legacy", "canonical")
WHERE "t"."kind" = 'automation'
  AND "t"."input" #>> '{task,profile_id}' = "m"."legacy";
--> statement-breakpoint

-- Run and step inputs that name the profile they ran as.
UPDATE "runs" AS "t"
SET "input" = jsonb_set("t"."input", '{profile_id}', to_jsonb("m"."canonical"))
FROM (VALUES
  ('sprouty-quick', 'sprouty'),
  ('sprouty-deep', 'sprouty'),
  ('sprouty-k3', 'sprouty'),
  ('sprouty-workflows', 'sprouty'),
  ('workflow-planner', 'sprouty'),
  ('sprouty-agents', 'sprouty'),
  ('sprouty-mission', 'sprouty'),
  ('eval-judge', 'sprouty'),
  ('team', 'sprouty'),
  ('default', 'sprouty'),
  ('researcher', 'sprouty'),
  ('writer', 'sprouty'),
  ('project-assistant', 'sprouty'),
  ('cs-quality', 'sprouty'),
  ('ops-analyst', 'sprouty'),
  ('cc-analyzer', 'sprouty'),
  ('crm', 'sprouty'),
  ('local-dev', 'desktop'),
  ('local-pi', 'desktop')
) AS "m"("legacy", "canonical")
WHERE "t"."input" #>> '{profile_id}' = "m"."legacy";
--> statement-breakpoint

UPDATE "run_steps" AS "t"
SET "input" = jsonb_set("t"."input", '{profile_id}', to_jsonb("m"."canonical"))
FROM (VALUES
  ('sprouty-quick', 'sprouty'),
  ('sprouty-deep', 'sprouty'),
  ('sprouty-k3', 'sprouty'),
  ('sprouty-workflows', 'sprouty'),
  ('workflow-planner', 'sprouty'),
  ('sprouty-agents', 'sprouty'),
  ('sprouty-mission', 'sprouty'),
  ('eval-judge', 'sprouty'),
  ('team', 'sprouty'),
  ('default', 'sprouty'),
  ('researcher', 'sprouty'),
  ('writer', 'sprouty'),
  ('project-assistant', 'sprouty'),
  ('cs-quality', 'sprouty'),
  ('ops-analyst', 'sprouty'),
  ('cc-analyzer', 'sprouty'),
  ('crm', 'sprouty'),
  ('local-dev', 'desktop'),
  ('local-pi', 'desktop')
) AS "m"("legacy", "canonical")
WHERE "t"."input" #>> '{profile_id}' = "m"."legacy";
