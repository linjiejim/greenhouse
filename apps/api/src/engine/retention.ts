import { and, eq, inArray, sql } from 'drizzle-orm';
import { getDb, runs, runSteps } from '@greenhouse/db';

export const RETENTION_JOB = 'engine_retention';
/** Only terminal runs lose model context; tool evidence and resumable runs remain intact. */
export async function pruneModelSteps(): Promise<number> {
  const rows = await getDb()
    .delete(runSteps)
    .where(
      and(
        eq(runSteps.kind, 'model'),
        inArray(
          runSteps.runId,
          getDb()
            .select({ id: runs.id })
            .from(runs)
            .where(
              and(
                inArray(runs.status, ['succeeded', 'failed', 'canceled']),
                sql`${runs.finishedAt} < now() - interval '90 days'`,
              ),
            ),
        ),
      ),
    )
    .returning({ id: runSteps.id });
  await getDb()
    .update(runs)
    .set({ checkpoint: sql`${runs.checkpoint} - 'eval'` })
    .where(
      and(
        inArray(runs.status, ['succeeded', 'failed', 'canceled']),
        sql`${runs.finishedAt} < now() - interval '90 days'`,
      ),
    );
  return rows.length;
}
