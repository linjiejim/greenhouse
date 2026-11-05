/**
 * Tables owned by the example extension. They are created by the extension's
 * own migration lane (`../migrations`), never by the core drizzle chain — keep
 * this file and `migrations/*.sql` in step.
 */
import { pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core';

export const exampleNotes = pgTable('ext_example_notes', {
  id: serial('id').primaryKey(),
  user_id: text('user_id').notNull(),
  body: text('body').notNull(),
  /** Content type of the note's picture (`notes/<id>/picture` in the plugin object store), when it has one. */
  picture_type: text('picture_type'),
  created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});

export type ExampleNoteRow = typeof exampleNotes.$inferSelect;
