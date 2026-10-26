-- greenhouse:core-generation 1x
-- Demonstrates the core-generation marker: this file was written against the
-- 1.x core (`sessions` is the 1.x name of `conversations`). 3.0 never runs it:
-- a fresh 3.0 database records it as skipped; a database carried from 1.x keeps
-- the row 1.x wrote, and refuses to boot if 1.x never applied it.
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "example_note_count" integer DEFAULT 0 NOT NULL;
