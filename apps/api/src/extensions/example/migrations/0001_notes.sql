CREATE TABLE ext_example_notes (
  id text PRIMARY KEY,
  member_id text NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  title text NOT NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX ext_example_notes_member_idx ON ext_example_notes(member_id, id);
--> statement-breakpoint
CREATE TABLE ext_example_settings (
  scope_id text PRIMARY KEY,
  member_id text REFERENCES members(id) ON DELETE CASCADE,
  label text NOT NULL
);
