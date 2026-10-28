-- Retired plugin tool ids become their successors, so the plugin seam that
-- expanded them at run time (retiredToolAliases) can go. Data only: no row
-- matches on a fresh install or on a second run.
--
-- team_knowledge, personal_knowledge -> knowledge_query (Knowledge)
-- project_manager -> project_query, project_mutation (Projects)
-- example_notes_legacy -> example_notes_query (Example)
--
-- Both tables are core, so the rewrite is a core migration. A successor stays
-- dormant while its plugin is off: an Agent's tools only narrow the member's
-- active tools. Automation unattended_tools are left alone: they are explicit
-- grants, and mapping a read alias onto project_mutation would widen one.

-- Custom Agents: each successor is listed once, where its first source stood.
UPDATE "run_profiles"
SET "tools" = (
  SELECT coalesce(jsonb_agg("tool" ORDER BY "ord", "sub"), '[]'::jsonb)
  FROM (
    SELECT "tool", "ord", "sub", row_number() OVER (PARTITION BY "tool" ORDER BY "ord", "sub") AS "nth"
    FROM (
      SELECT coalesce(to_jsonb("m"."successor"), "e"."elem") AS "tool", "e"."ord", coalesce("m"."pos", 0) AS "sub"
      FROM jsonb_array_elements("run_profiles"."tools") WITH ORDINALITY AS "e"("elem", "ord")
      LEFT JOIN (VALUES
        ('team_knowledge', 'knowledge_query', 1),
        ('personal_knowledge', 'knowledge_query', 1),
        ('project_manager', 'project_query', 1),
        ('project_manager', 'project_mutation', 2),
        ('example_notes_legacy', 'example_notes_query', 1)
      ) AS "m"("retired", "successor", "pos") ON "e"."elem" = to_jsonb("m"."retired")
    ) AS "mapped"
  ) AS "numbered"
  WHERE "nth" = 1
    OR "tool" NOT IN ('"knowledge_query"', '"project_query"', '"project_mutation"', '"example_notes_query"')
)
WHERE jsonb_typeof("tools") = 'array'
  AND "tools" ?| ARRAY['team_knowledge', 'personal_knowledge', 'project_manager', 'example_notes_legacy'];
--> statement-breakpoint

-- Saved prompts: the tools a prompt expects (a hint; it grants nothing).
UPDATE "prompts"
SET "expected_tools" = (
  SELECT coalesce(jsonb_agg("tool" ORDER BY "ord", "sub"), '[]'::jsonb)
  FROM (
    SELECT "tool", "ord", "sub", row_number() OVER (PARTITION BY "tool" ORDER BY "ord", "sub") AS "nth"
    FROM (
      SELECT coalesce(to_jsonb("m"."successor"), "e"."elem") AS "tool", "e"."ord", coalesce("m"."pos", 0) AS "sub"
      FROM jsonb_array_elements("prompts"."expected_tools") WITH ORDINALITY AS "e"("elem", "ord")
      LEFT JOIN (VALUES
        ('team_knowledge', 'knowledge_query', 1),
        ('personal_knowledge', 'knowledge_query', 1),
        ('project_manager', 'project_query', 1),
        ('project_manager', 'project_mutation', 2),
        ('example_notes_legacy', 'example_notes_query', 1)
      ) AS "m"("retired", "successor", "pos") ON "e"."elem" = to_jsonb("m"."retired")
    ) AS "mapped"
  ) AS "numbered"
  WHERE "nth" = 1
    OR "tool" NOT IN ('"knowledge_query"', '"project_query"', '"project_mutation"', '"example_notes_query"')
)
WHERE jsonb_typeof("expected_tools") = 'array'
  AND "expected_tools" ?| ARRAY['team_knowledge', 'personal_knowledge', 'project_manager', 'example_notes_legacy'];
