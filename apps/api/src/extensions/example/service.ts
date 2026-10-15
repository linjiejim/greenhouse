import { and, asc, eq, gt, ilike } from 'drizzle-orm';
import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { getDb, members, newId, transaction } from '@greenhouse/db';
import type { z } from 'zod';
import { type noteInputSchema, type ExampleNote } from '@greenhouse/contract/extensions/example';
import { audit, forbidden, notFound, containing, decodeCursor, toPage } from '../../extension-kit.js';

const notes = pgTable('ext_example_notes', {
  id: text('id').primaryKey(),
  memberId: text('member_id').notNull(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
});
const settings = pgTable('ext_example_settings', {
  scopeId: text('scope_id').primaryKey(),
  memberId: text('member_id'),
  label: text('label').notNull(),
});
const view = (row: typeof notes.$inferSelect): ExampleNote => ({
  id: row.id,
  title: row.title,
  body: row.body,
  created_at: row.createdAt,
});

async function active(memberId: string, admin = false) {
  const [member] = await getDb().select().from(members).where(eq(members.id, memberId));
  if (member?.status !== 'active' || (admin && member.role !== 'admin')) throw forbidden();
}

export const exampleService = {
  async list(memberId: string, query: { cursor?: string; limit: number; q?: string }) {
    await active(memberId);
    const after = decodeCursor(query.cursor);
    const rows = await getDb()
      .select()
      .from(notes)
      .where(
        and(
          eq(notes.memberId, memberId),
          after ? gt(notes.id, after) : undefined,
          query.q ? ilike(notes.title, containing(query.q)) : undefined,
        ),
      )
      .orderBy(asc(notes.id))
      .limit(query.limit + 1);
    return toPage(rows, query.limit, view);
  },
  async get(memberId: string, id: string) {
    await active(memberId);
    const [row] = await getDb()
      .select()
      .from(notes)
      .where(and(eq(notes.memberId, memberId), eq(notes.id, id)));
    if (!row) throw notFound();
    return view(row);
  },
  async create(memberId: string, input: z.output<typeof noteInputSchema>) {
    await active(memberId);
    const [row] = await getDb()
      .insert(notes)
      .values({ id: newId('note'), memberId, ...input, createdAt: new Date().toISOString() })
      .returning();
    return view(row!);
  },
  async settings(memberId: string, isAdmin: boolean) {
    await active(memberId, isAdmin);
    const [row] = await getDb()
      .select()
      .from(settings)
      .where(eq(settings.scopeId, isAdmin ? 'workspace' : memberId));
    return { label: row?.label ?? 'Example' };
  },
  async saveSettings(memberId: string, isAdmin: boolean, label: string) {
    return transaction(async (db) => {
      await active(memberId, isAdmin);
      const scopeId = isAdmin ? 'workspace' : memberId;
      await db
        .insert(settings)
        .values({ scopeId, memberId: isAdmin ? null : memberId, label })
        .onConflictDoUpdate({ target: settings.scopeId, set: { label } });
      if (isAdmin)
        await audit({
          actorId: memberId,
          action: 'extension.example.settings',
          resourceType: 'extension',
          resourceId: 'example',
          summary: 'label',
        });
      return { label };
    });
  },
};
