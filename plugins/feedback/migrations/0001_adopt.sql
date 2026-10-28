-- Adopt the 3.0 table in place; disabling the plugin preserves its data.
CREATE TABLE IF NOT EXISTS "feedback" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"status" text NOT NULL,
	"note" text,
	"submitted_by" text,
	"priority" text,
	"session_id" text,
	"fingerprint" text,
	"tool_id" text,
	"friction_kind" text,
	"occurrence_count" integer DEFAULT 1 NOT NULL,
	"sample_sessions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"first_seen_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_feedback_kind" CHECK ("feedback"."kind" IN ('request', 'friction')),
	CONSTRAINT "chk_feedback_priority" CHECK ("feedback"."priority" IN ('low', 'normal', 'high')),
	CONSTRAINT "chk_feedback_friction_kind" CHECK ("feedback"."friction_kind" IN ('tool_error', 'wrong_params', 'detour', 'data_quirk', 'capability_gap')),
	CONSTRAINT "chk_feedback_shape" CHECK (("feedback"."kind" = 'request' AND "feedback"."status" IN ('pending', 'accepted', 'rejected', 'done') AND "feedback"."submitted_by" IS NOT NULL AND "feedback"."priority" IS NOT NULL AND "feedback"."fingerprint" IS NULL)
        OR ("feedback"."kind" = 'friction' AND "feedback"."status" IN ('new', 'acknowledged', 'resolved', 'archived') AND "feedback"."fingerprint" IS NOT NULL AND "feedback"."friction_kind" IS NOT NULL AND "feedback"."first_seen_at" IS NOT NULL AND "feedback"."last_seen_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_feedback_fingerprint" ON "feedback" USING btree ("fingerprint") WHERE "feedback"."fingerprint" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_feedback_kind_status" ON "feedback" USING btree ("kind","status","updated_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_feedback_tool" ON "feedback" USING btree ("tool_id");
