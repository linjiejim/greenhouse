import { pgTable, primaryKey, text } from 'drizzle-orm/pg-core';
import { at } from './_columns.js';

export const extensionMigrations = pgTable(
  'extension_migrations',
  {
    extensionId: text('extension_id').notNull(),
    name: text('name').notNull(),
    checksum: text('checksum').notNull(),
    appliedAt: at('applied_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.extensionId, t.name] })],
);
