/** Owner-only Bots data must stay private in every materialized read model. */
import { eq, not, or, sql } from 'drizzle-orm';
import { BOTS_SESSION_CHANNEL, BOT_TASK_SESSION_PREFIX } from '@greenhouse/types/session';
import { runtimeRuns, sessions } from './schema/index.js';

export function ownerOnlySessionCondition() {
  return or(eq(sessions.channel, BOTS_SESSION_CHANNEL), sql`starts_with(${sessions.id}, ${BOT_TASK_SESSION_PREFIX})`)!;
}

export function sessionVisibleTo(viewerUserId: string) {
  return or(eq(sessions.user_id, viewerUserId), not(ownerOnlySessionCondition()));
}

/** Durable markers also protect traces after the source session is deleted. */
export function runtimeVisibleTo(viewerUserId: string | undefined) {
  if (viewerUserId === undefined) return undefined; // internal engine callers
  const privateRun = or(
    sql`starts_with(${runtimeRuns.source_id}, 'bots:')`,
    sql`starts_with(${runtimeRuns.source_id}, ${BOT_TASK_SESSION_PREFIX})`,
    sql`starts_with(coalesce(${runtimeRuns.session_id}, ''), ${BOT_TASK_SESSION_PREFIX})`,
    sql`coalesce(${runtimeRuns.input}::jsonb ->> 'source_mode', '') = 'bots'`,
    sql`exists (select 1 from ${sessions} where ${sessions.id} = ${runtimeRuns.session_id}
      and ${ownerOnlySessionCondition()})`,
  )!;
  return or(eq(runtimeRuns.owner_user_id, viewerUserId), not(privateRun));
}
