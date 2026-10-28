-- Rewrites data shapes that 1.x wrote and 3.x carried verbatim, so 4.0 reads
-- only the current shapes. Data only: every statement matches no rows on a
-- fresh install and none on a second run. JSON text is parsed in plpgsql
-- blocks (no pg_input_is_valid) so the migration runs on any PostgreSQL.

-- Automation result notifications: the task id is text.
UPDATE "notifications"
SET "payload" = jsonb_set("payload", '{task_id}', to_jsonb("payload"->>'task_id'))
WHERE "payload"->>'type' = 'automation_result'
  AND jsonb_typeof("payload"->'task_id') = 'number';
--> statement-breakpoint

-- Runtime outbox: the payload is JSON, never JSON text. Unparseable text stays
-- as it is (the worker dead-letters it, as before).
DO $$
DECLARE
  item record;
  parsed jsonb;
BEGIN
  FOR item IN SELECT "id", "payload" #>> '{}' AS "raw" FROM "run_outbox" WHERE jsonb_typeof("payload") = 'string' LOOP
    BEGIN
      parsed := item.raw::jsonb;
    EXCEPTION WHEN invalid_text_representation THEN
      parsed := NULL;
    END;
    IF parsed IS NOT NULL THEN
      UPDATE "run_outbox" SET "payload" = parsed WHERE "id" = item.id;
    END IF;
  END LOOP;
END $$;
--> statement-breakpoint

-- Automation run inputs: the task id is text.
UPDATE "runs"
SET "input" = jsonb_set("input", '{task_id}', to_jsonb("input"->>'task_id'))
WHERE "kind" = 'automation'
  AND jsonb_typeof("input"->'task_id') = 'number';
--> statement-breakpoint

-- Automation task snapshots: the task id is text.
UPDATE "runs"
SET "input" = jsonb_set("input", '{task,id}', to_jsonb("input" #>> '{task,id}'))
WHERE "kind" = 'automation'
  AND jsonb_typeof("input"->'task') = 'object'
  AND jsonb_typeof("input" #> '{task,id}') = 'number';
--> statement-breakpoint

-- Automation task snapshots: the four flat notify_* fields become one notify object.
UPDATE "runs"
SET "input" = jsonb_set(
  "input",
  '{task}',
  (("input"->'task') - 'notify_webhook' - 'notify_email' - 'notify_wecom' - 'notify_feishu')
    || jsonb_build_object(
      'notify',
      jsonb_build_object(
        'webhook',
        CASE
          WHEN jsonb_typeof("input" #> '{task,notify_webhook}') = 'string'
            AND "input" #>> '{task,notify_webhook}' <> ''
          THEN "input" #> '{task,notify_webhook}'
          ELSE 'null'::jsonb
        END,
        'email', coalesce("input" #> '{task,notify_email}' = 'true'::jsonb, false),
        'wecom', coalesce("input" #> '{task,notify_wecom}' = 'true'::jsonb, false),
        'feishu', coalesce("input" #> '{task,notify_feishu}' = 'true'::jsonb, false)
      )
    )
)
WHERE "kind" = 'automation'
  AND jsonb_typeof("input"->'task') = 'object'
  AND coalesce(jsonb_typeof("input" #> '{task,notify}'), 'missing') NOT IN ('object', 'array');
--> statement-breakpoint

-- Automation task snapshots: unattended_tools is an array, never JSON text;
-- anything that does not parse to an array becomes [].
DO $$
DECLARE
  item record;
  parsed jsonb;
BEGIN
  FOR item IN
    SELECT "id", "input" #>> '{task,unattended_tools}' AS "raw"
    FROM "runs"
    WHERE "kind" = 'automation'
      AND jsonb_typeof("input"->'task') = 'object'
      AND jsonb_typeof("input" #> '{task,unattended_tools}') = 'string'
  LOOP
    BEGIN
      parsed := item.raw::jsonb;
    EXCEPTION WHEN invalid_text_representation THEN
      parsed := NULL;
    END;
    IF jsonb_typeof(parsed) IS DISTINCT FROM 'array' THEN
      parsed := '[]'::jsonb;
    END IF;
    UPDATE "runs" SET "input" = jsonb_set("input", '{task,unattended_tools}', parsed) WHERE "id" = item.id;
  END LOOP;
END $$;
--> statement-breakpoint

-- Custom Agents: the retired session_history tool becomes session_query, listed once.
UPDATE "run_profiles"
SET "tools" = (
  SELECT coalesce(jsonb_agg("tool" ORDER BY "ord"), '[]'::jsonb)
  FROM (
    SELECT "tool", "ord", row_number() OVER (PARTITION BY "tool" ORDER BY "ord") AS "nth"
    FROM (
      SELECT
        CASE WHEN "elem" = '"session_history"'::jsonb THEN '"session_query"'::jsonb ELSE "elem" END AS "tool",
        "ord"
      FROM jsonb_array_elements("run_profiles"."tools") WITH ORDINALITY AS "e"("elem", "ord")
    ) AS "mapped"
  ) AS "numbered"
  WHERE "nth" = 1 OR "tool" <> '"session_query"'::jsonb
)
WHERE jsonb_typeof("tools") = 'array'
  AND "tools" @> '["session_history"]'::jsonb;
--> statement-breakpoint

-- Saved prompts: variables and expected_tools are arrays, never JSON text;
-- anything that does not parse to an array becomes [].
DO $$
DECLARE
  item record;
  new_variables jsonb;
  new_expected_tools jsonb;
BEGIN
  FOR item IN
    SELECT "id", "variables" AS "raw_variables", "expected_tools" AS "raw_expected_tools"
    FROM "prompts"
    WHERE jsonb_typeof("variables") = 'string' OR jsonb_typeof("expected_tools") = 'string'
  LOOP
    new_variables := item.raw_variables;
    IF jsonb_typeof(new_variables) = 'string' THEN
      BEGIN
        new_variables := (new_variables #>> '{}')::jsonb;
      EXCEPTION WHEN invalid_text_representation THEN
        new_variables := NULL;
      END;
      IF jsonb_typeof(new_variables) IS DISTINCT FROM 'array' THEN
        new_variables := '[]'::jsonb;
      END IF;
    END IF;
    new_expected_tools := item.raw_expected_tools;
    IF jsonb_typeof(new_expected_tools) = 'string' THEN
      BEGIN
        new_expected_tools := (new_expected_tools #>> '{}')::jsonb;
      EXCEPTION WHEN invalid_text_representation THEN
        new_expected_tools := NULL;
      END;
      IF jsonb_typeof(new_expected_tools) IS DISTINCT FROM 'array' THEN
        new_expected_tools := '[]'::jsonb;
      END IF;
    END IF;
    UPDATE "prompts" SET "variables" = new_variables, "expected_tools" = new_expected_tools WHERE "id" = item.id;
  END LOOP;
END $$;
