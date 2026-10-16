import { eq, sql } from 'drizzle-orm';
import { getDb, members, transaction, workspace } from '@greenhouse/db';
import {
  OPERATION_SWITCHES,
  operationSwitchesSchema,
  type OperationSwitch,
  type OperationSwitches,
} from '@greenhouse/contract';
import { audit } from '../../audit.js';
import type { AppConfig } from '../../config/index.js';
import { ApiError, forbidden } from '../../http/errors.js';

export function createOperationsService(config: AppConfig) {
  const defaults: OperationSwitches = {
    pause_background_runs: config.PAUSE_BACKGROUND_RUNS,
    disable_computers: config.DISABLE_COMPUTERS,
    disable_outbound_mail: config.DISABLE_OUTBOUND_MAIL,
  };
  async function read(lock = false): Promise<OperationSwitches> {
    const query = getDb().select({ settings: workspace.settings }).from(workspace).where(eq(workspace.id, 'default'));
    const [row] = await (lock ? query.for('share') : query);
    return operationSwitchesSchema.parse({
      ...defaults,
      ...(row?.settings.kill_switches as Partial<OperationSwitches> | undefined),
    });
  }
  async function admin(actorId: string) {
    const [actor] = await getDb().select().from(members).where(eq(members.id, actorId));
    if (actor?.role !== 'admin' || actor.status !== 'active') throw forbidden();
  }
  return {
    read,
    /** Members may explain unavailable operations; changing them remains admin-only. */
    async memberStatus(actorId: string) {
      const [actor] = await getDb().select().from(members).where(eq(members.id, actorId));
      if (actor?.status !== 'active') throw forbidden();
      return read();
    },
    async assertEnabled(key: OperationSwitch) {
      if ((await read())[key])
        throw new ApiError(503, 'operation_disabled', 'An admin temporarily paused this operation.', { switch: key });
    },
    async get(actorId: string) {
      await admin(actorId);
      return read();
    },
    async update(actorId: string, patch: Partial<OperationSwitches>) {
      return transaction(async (db) => {
        await admin(actorId);
        await db.insert(workspace).values({ id: 'default' }).onConflictDoNothing();
        await db.select({ id: workspace.id }).from(workspace).where(eq(workspace.id, 'default')).for('update');
        const next = { ...(await read()), ...patch };
        await db
          .update(workspace)
          .set({
            settings: sql`jsonb_set(${workspace.settings}, '{kill_switches}', ${JSON.stringify(next)}::jsonb)`,
            updatedBy: actorId,
            updatedAt: sql`now()`,
          })
          .where(eq(workspace.id, 'default'));
        await audit({
          actorId,
          action: 'operations.update',
          resourceType: 'workspace',
          resourceId: 'default',
          summary: OPERATION_SWITCHES.filter((key) => key in patch).join(', '),
        });
        return next;
      });
    },
  };
}
export type OperationsService = ReturnType<typeof createOperationsService>;
