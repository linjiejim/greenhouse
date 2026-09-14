CREATE TABLE IF NOT EXISTS "ext_example_notes" (
  "id" serial PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL,
  "body" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ext_example_notes_user" ON "ext_example_notes" ("user_id", "created_at");
