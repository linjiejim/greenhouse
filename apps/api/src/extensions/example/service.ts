import { desc, eq, sql } from 'drizzle-orm';
import type { Db } from '@greenhouse/db';
import { exampleNotes, type ExampleNoteRow } from './schema.js';

export function createExampleNoteService(db: Db) {
  return {
    async list(userId: string, limit = 20): Promise<ExampleNoteRow[]> {
      return db
        .select()
        .from(exampleNotes)
        .where(eq(exampleNotes.user_id, userId))
        .orderBy(desc(exampleNotes.id))
        .limit(limit);
    },
    async add(userId: string, body: string): Promise<ExampleNoteRow> {
      const [row] = await db.insert(exampleNotes).values({ user_id: userId, body }).returning();
      return row;
    },
    async remove(userId: string, id: number): Promise<boolean> {
      const rows = await db
        .delete(exampleNotes)
        .where(sql`${exampleNotes.id} = ${id} AND ${exampleNotes.user_id} = ${userId}`)
        .returning({ id: exampleNotes.id });
      return rows.length > 0;
    },
    async get(userId: string, id: number): Promise<ExampleNoteRow | undefined> {
      const [row] = await db
        .select()
        .from(exampleNotes)
        .where(sql`${exampleNotes.id} = ${id} AND ${exampleNotes.user_id} = ${userId}`)
        .limit(1);
      return row;
    },
    async search(userId: string, query: string, limit: number): Promise<ExampleNoteRow[]> {
      return db
        .select()
        .from(exampleNotes)
        .where(sql`${exampleNotes.user_id} = ${userId} AND ${exampleNotes.body} ILIKE ${'%' + query + '%'}`)
        .orderBy(desc(exampleNotes.id))
        .limit(limit);
    },
    async count(): Promise<number> {
      const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(exampleNotes);
      return row?.n ?? 0;
    },
  };
}

/** The bag exposed as `db.extensions.example`. */
export function createExampleServices(db: Db) {
  return { notes: createExampleNoteService(db) };
}

export type ExampleServices = ReturnType<typeof createExampleServices>;
