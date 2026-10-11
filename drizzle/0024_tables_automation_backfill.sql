-- Tables automations go asynchronous (docs/specs/20261011-tables-foundation.md §4, D10).
-- Custom migration, data only: no DDL. `table_notifications` stays (expand–contract):
-- an older image rolled back onto this database still reads and writes it; the
-- next release drops it.

-- 1. The legacy Tables inbox moves into the platform notification center. One
--    fact per legacy row, keyed by its id so a re-run inserts nothing twice.
INSERT INTO "notifications" ("id", "user_id", "kind", "title", "body", "payload", "dedupe_key", "read_at", "created_at")
SELECT
	'ntf_' || replace(gen_random_uuid()::text, '-', ''),
	tn."user_id",
	'tables_automation',
	left(coalesce(nullif(btrim(tn."title"), ''), 'Tables'), 512),
	tn."message",
	json_build_object('href', '#/tables/' || tn."base_id")::text,
	'tables-notification:' || tn."id",
	tn."read_at",
	tn."created_at"
FROM "table_notifications" tn
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- 2. Runs the synchronous executor left open (a crash mid-run) can never finish.
UPDATE "table_automation_runs" r
SET "status" = 'failed',
	"error" = 'legacy_sync_executor',
	"finished_at" = coalesce(r."finished_at", now())
WHERE r."status" = 'running'
	AND (
		r."outbox_id" IS NULL
		OR EXISTS (
			SELECT 1 FROM "table_automation_outbox" o
			WHERE o."id" = r."outbox_id" AND o."rule_revision" IS NULL
		)
	);
--> statement-breakpoint
-- 3. Legacy outbox rows carry no rule revision or action snapshot; the async
--    worker never claims them (it only takes `rule_revision IS NOT NULL`), so
--    settle the unfinished ones as failed instead of leaving them pending forever.
UPDATE "table_automation_outbox"
SET "status" = 'failed',
	"last_error" = 'legacy_sync_executor',
	"processed_at" = coalesce("processed_at", now())
WHERE "status" IN ('pending', 'processing') AND "rule_revision" IS NULL;
--> statement-breakpoint
-- 4. Stable action ids: keep every string id, give the rest `a<n>` — the 1-based
--    position, bumped past ids already taken (the same rule as
--    `assignAutomationActionIds` in packages/db/src/services/tables/automations.ts).
DO $$
DECLARE
	rule_row record;
	action_value jsonb;
	used_ids text[];
	next_index integer;
	position_index integer;
	result jsonb;
BEGIN
	FOR rule_row IN
		SELECT "id", "config" FROM "table_automation_rules"
		WHERE jsonb_typeof("config" -> 'actions') = 'array'
			AND EXISTS (
				SELECT 1 FROM jsonb_array_elements("config" -> 'actions') AS element
				WHERE jsonb_typeof(element) = 'object' AND jsonb_typeof(element -> 'id') IS DISTINCT FROM 'string'
			)
	LOOP
		SELECT coalesce(array_agg(element ->> 'id'), ARRAY[]::text[]) INTO used_ids
		FROM jsonb_array_elements(rule_row."config" -> 'actions') AS element
		WHERE jsonb_typeof(element -> 'id') = 'string';
		result := '[]'::jsonb;
		position_index := 0;
		FOR action_value IN
			SELECT element FROM jsonb_array_elements(rule_row."config" -> 'actions') WITH ORDINALITY AS t(element, ordinal)
			ORDER BY ordinal
		LOOP
			position_index := position_index + 1;
			IF jsonb_typeof(action_value) <> 'object' OR jsonb_typeof(action_value -> 'id') = 'string' THEN
				result := result || jsonb_build_array(action_value);
			ELSE
				next_index := position_index;
				WHILE ('a' || next_index) = ANY (used_ids) LOOP
					next_index := next_index + 1;
				END LOOP;
				used_ids := array_append(used_ids, 'a' || next_index);
				result := result || jsonb_build_array(action_value || jsonb_build_object('id', 'a' || next_index));
			END IF;
		END LOOP;
		UPDATE "table_automation_rules"
		SET "config" = jsonb_set("config", '{actions}', result)
		WHERE "id" = rule_row."id";
	END LOOP;
END $$;
