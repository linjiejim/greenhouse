/** Custom-code approval follows the exact immutable spec hash, never the app id. */
import type { DatabaseProvider, TableAppAudienceInput, TableAppRow } from '@greenhouse/db';
import { humanActor } from '../actor.js';
import { requireAppManager } from './access.js';

export { customVersionApproved, hasCustomCards } from './app-custom-review-status.js';

/** Groups and everyone can gain members later, so they always need review. */
export async function audiencesNeedCustomReview(
  db: DatabaseProvider,
  app: TableAppRow,
  entries: readonly TableAppAudienceInput[],
): Promise<boolean> {
  const base = await db.tables.getBase(app.base_id);
  if (!base) return true;
  for (const entry of entries) {
    if (entry.principal_type !== 'user' || !entry.user_id) return true;
    if (!(await requireAppManager({ db }, humanActor({ id: entry.user_id }), base))) return true;
  }
  return false;
}
