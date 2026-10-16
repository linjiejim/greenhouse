/** Only logical ids and enum counts; no message content, names, prompts or arbitrary metadata. */
import { sql, type SQL } from 'drizzle-orm';
import { getDb, metricEvents } from '@greenhouse/db';

export async function recordCount(
  memberId: string,
  kind: 'active' | 'assigned' | 'adopted' | 'activated',
  key: string | SQL,
) {
  await getDb()
    .insert(metricEvents)
    .values({ memberId, kind, key })
    .onConflictDoNothing({ target: [metricEvents.memberId, metricEvents.kind, metricEvents.key] });
}
const dayKey = () => sql`to_char(now() at time zone 'UTC', 'YYYY-MM-DD')`;
export const countActive = (memberId: string) => recordCount(memberId, 'active', dayKey());
export async function countAssignment(memberId: string) {
  await countActive(memberId);
  await recordCount(memberId, 'assigned', dayKey());
}
export async function countAdoption(memberId: string, output: string) {
  await countActive(memberId);
  await recordCount(memberId, 'adopted', output);
}

export const adoptedOutputKey = (runId: string | null, kind: 'message' | 'file' | 'step', id: string) =>
  runId ? `run:${runId}` : `${kind}:${id}`;
