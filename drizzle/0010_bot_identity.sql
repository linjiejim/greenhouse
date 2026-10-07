CREATE TABLE "bot_versions" (
	"id" serial PRIMARY KEY NOT NULL,
	"bot_id" text NOT NULL,
	"version" integer NOT NULL,
	"manifest_hash" text NOT NULL,
	"change_log" text DEFAULT '' NOT NULL,
	"name" text NOT NULL,
	"role" text DEFAULT '' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"instructions" text DEFAULT '' NOT NULL,
	"tools" text,
	"model_id" text,
	"max_steps" integer,
	"avatar" text DEFAULT '{}' NOT NULL,
	"purpose" text,
	"audience" text,
	"risk_level" text DEFAULT 'medium' NOT NULL,
	"budget_policy" text DEFAULT '{}' NOT NULL,
	"eval_refs" text DEFAULT '[]' NOT NULL,
	"owner_backup_user_id" text,
	"review_due_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_bot_versions_bot_version" UNIQUE("bot_id","version")
);
--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "description" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "tools" text;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "max_steps" integer;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "is_shared" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "lifecycle_status" text DEFAULT 'draft' NOT NULL;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "lifecycle_note" text;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "current_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "published_version" integer;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "owner_backup_user_id" text;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "reviewed_by" text;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "next_review_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "forked_from" text;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "legacy_custom_id" integer;--> statement-breakpoint
ALTER TABLE "bot_versions" ADD CONSTRAINT "bot_versions_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_bot_versions_bot" ON "bot_versions" USING btree ("bot_id");--> statement-breakpoint
CREATE INDEX "idx_bot_versions_created" ON "bot_versions" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "bots" ADD CONSTRAINT "bots_owner_backup_user_id_users_id_fk" FOREIGN KEY ("owner_backup_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_bots_shared" ON "bots" USING btree ("is_shared","lifecycle_status");--> statement-breakpoint
CREATE INDEX "idx_bots_backup_owner" ON "bots" USING btree ("owner_backup_user_id");--> statement-breakpoint
ALTER TABLE "bots" ADD CONSTRAINT "uq_bots_legacy_custom_id" UNIQUE("legacy_custom_id");--> statement-breakpoint
-- ── Data: every existing Bot gets its immutable version 1 (its definition as of this migration).
-- The hash is computed in SQL (not by the service's manifest encoder): it is an audit value, nothing
-- recomputes or verifies it.
INSERT INTO "bot_versions" ("bot_id", "version", "manifest_hash", "change_log", "name", "role", "description", "instructions", "tools", "model_id", "max_steps", "avatar", "created_by", "created_at")
SELECT b."id", 1,
       encode(sha256(convert_to(json_build_object('name', b."name", 'role', b."role", 'description', b."description", 'instructions', b."instructions", 'tools', b."tools", 'model_id', b."model_id", 'max_steps', b."max_steps", 'avatar', b."avatar")::text, 'UTF8')), 'hex'),
       'Initial version (backfilled by migration 0010)',
       b."name", b."role", b."description", b."instructions", b."tools", b."model_id", b."max_steps", b."avatar", b."user_id", b."created_at"
FROM "bots" b
WHERE NOT EXISTS (SELECT 1 FROM "bot_versions" v WHERE v."bot_id" = b."id");--> statement-breakpoint
-- ── Data: every custom Agent becomes a Bot of its owner (docs/specs/20261007-agent-bot-convergence.md §2.1).
-- Ids are deterministic (`bot_` + 16 hex of md5('custom:<id>')); version numbers are copied one-to-one so a
-- stored `custom:<id>@<v>` reference resolves to `bot:<new id>@<v>` through `legacy_custom_id`. Names follow
-- the Bot rules (no `[ ] : ：` or control characters, ≤ 24 characters, unique among the owner's active Bots);
-- the role is the first sentence of the purpose / description, ≤ 40 characters. The old tables are dropped
-- by the next migration.
DO $$
DECLARE
  cp RECORD;
  v RECORD;
  new_id text;
  base_name text;
  candidate text;
  candidate_key text;
  suffix integer;
  role_text text;
  current_purpose text;
BEGIN
  FOR cp IN SELECT * FROM "custom_profiles" ORDER BY "id" LOOP
    new_id := 'bot_' || left(md5('custom:' || cp."id"::text), 16);
    base_name := left(btrim(regexp_replace(regexp_replace(translate(cp."name", '[]:：', '    '), '[[:cntrl:]]+', ' ', 'g'), '\s+', ' ', 'g')), 24);
    IF base_name = '' THEN base_name := 'Agent'; END IF;
    candidate := base_name;
    suffix := 1;
    LOOP
      candidate_key := lower(btrim(normalize(candidate, NFKC)));
      EXIT WHEN cp."lifecycle_status" = 'archived'
        OR NOT EXISTS (SELECT 1 FROM "bots" b WHERE b."user_id" = cp."user_id" AND b."status" = 'active' AND b."name_key" = candidate_key);
      suffix := suffix + 1;
      candidate := left(base_name, 24 - length(' ' || suffix::text)) || ' ' || suffix::text;
    END LOOP;
    SELECT pv."purpose" INTO current_purpose FROM "custom_profile_versions" pv WHERE pv."profile_id" = cp."id" AND pv."version" = cp."current_version";
    role_text := left(btrim(split_part(regexp_replace(coalesce(current_purpose, cp."description", ''), '[。.!！?？]', E'\n', 'g'), E'\n', 1)), 40);
    INSERT INTO "bots" ("id", "user_id", "name", "name_key", "role", "description", "instructions", "avatar", "model_id", "tools", "max_steps", "template_key", "status", "is_shared", "lifecycle_status", "lifecycle_note", "current_version", "published_version", "owner_backup_user_id", "reviewed_by", "reviewed_at", "next_review_at", "forked_from", "legacy_custom_id", "created_at", "updated_at")
    VALUES (new_id, cp."user_id", candidate, candidate_key, role_text, coalesce(cp."description", ''), cp."system_prompt", cp."avatar", cp."model_id", cp."tools", cp."max_steps", NULL,
            CASE WHEN cp."lifecycle_status" = 'archived' THEN 'archived' ELSE 'active' END,
            cp."is_shared", cp."lifecycle_status", cp."lifecycle_note", cp."current_version", cp."published_version", cp."owner_backup_user_id", cp."reviewed_by", cp."reviewed_at", cp."next_review_at", cp."forked_from", cp."id", cp."created_at", cp."updated_at");
    FOR v IN SELECT * FROM "custom_profile_versions" pv WHERE pv."profile_id" = cp."id" ORDER BY pv."version" LOOP
      INSERT INTO "bot_versions" ("bot_id", "version", "manifest_hash", "change_log", "name", "role", "description", "instructions", "tools", "model_id", "max_steps", "avatar", "purpose", "audience", "risk_level", "budget_policy", "eval_refs", "owner_backup_user_id", "review_due_at", "created_by", "created_at")
      VALUES (new_id, v."version", v."manifest_hash", v."change_log",
              coalesce(nullif(left(btrim(regexp_replace(regexp_replace(translate(v."name", '[]:：', '    '), '[[:cntrl:]]+', ' ', 'g'), '\s+', ' ', 'g')), 24), ''), 'Agent'),
              left(btrim(split_part(regexp_replace(coalesce(v."purpose", v."description", ''), '[。.!！?？]', E'\n', 'g'), E'\n', 1)), 40),
              coalesce(v."description", ''), v."system_prompt", v."tools", v."model_id", v."max_steps", v."avatar",
              v."purpose", v."audience", v."risk_level", v."budget_policy", v."eval_refs", v."owner_backup_user_id", v."review_due_at", v."created_by", v."created_at");
    END LOOP;
  END LOOP;
END $$;
