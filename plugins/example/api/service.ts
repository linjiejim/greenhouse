import {
  delegatedAgentActor,
  getPlatformRuntime,
  recordWrite,
  getDb,
  resolveEntityPolicy,
  projectReadableFields,
  fieldPolicyFor,
} from '@greenhouse/api/extension-kit';
import { HTTPException } from 'hono/http-exception';
import { desc, eq, sql } from 'drizzle-orm';
import type { Db } from '@greenhouse/api/extension-kit';
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

/** Compatibility adapters retain their wire shape while using the data app's permissions and audit. */
export async function noteAction<T>(
  actor: string | import('@greenhouse/api/extension-kit').ActorContext,
  action: 'read' | 'create' | 'delete' | 'export',
  operation: () => Promise<T>,
): Promise<T> {
  const request = {
    actor: typeof actor === 'string' ? delegatedAgentActor({ userId: actor }) : actor,
    appId: 'example',
    actionId: `note${action[0].toUpperCase()}${action.slice(1)}`,
    payload: {},
  };
  const bound = async () => {
    const userId = typeof actor === 'string' ? actor : (actor.onBehalfOfUserId ?? actor.actorId);
    const snapshot = await getDb().platform.getEntityPolicySnapshot({ userId, appId: 'example', entityId: 'note' });
    const policy = resolveEntityPolicy(snapshot.rolePolicies);
    if (!policy.scopes.length || (action === 'create' && !fieldPolicyFor(policy, 'body').write))
      return { ok: false as const, code: 'FORBIDDEN' as const, message: 'Note policy denied' };
    const project = (row: Record<string, unknown>) => {
      const normalized = Object.fromEntries(
        Object.entries(row).map(([key, value]) => [
          key === 'user_id' ? 'userId' : key === 'created_at' ? 'createdAt' : key,
          value,
        ]),
      );
      const permitted =
        action === 'export'
          ? Object.fromEntries(
              Object.entries(normalized).filter(
                ([key]) => fieldPolicyFor(policy, key).export && fieldPolicyFor(policy, key).read === 'full',
              ),
            )
          : normalized;
      return Object.fromEntries(
        Object.entries(projectReadableFields(permitted, policy, () => '***')).map(([key, value]) => [
          key === 'userId' ? 'user_id' : key === 'createdAt' ? 'created_at' : key,
          value,
        ]),
      );
    };
    const data = await operation();
    const projected = Array.isArray(data)
      ? data.map(project)
      : data && typeof data === 'object' && 'id' in data
        ? project(data as Record<string, unknown>)
        : data;
    return { ok: true as const, data: projected };
  };
  const result =
    action === 'read' || action === 'export'
      ? await getPlatformRuntime().dispatch(request, bound)
      : await recordWrite(request, bound);
  if (!result.ok) throw new HTTPException(result.code === 'FORBIDDEN' ? 403 : 400, { message: result.message });
  return result.data as T;
}
