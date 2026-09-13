/**
 * Automatic governance for published custom Agents.
 *
 * The worker is deliberately a thin policy loop over the DB service: lifecycle
 * transitions stay serialized by `customProfiles.transitionLifecycle`, while
 * permanent notification rows provide the durable user-facing evidence.
 */

import type { CustomProfileOwnershipCandidate, CustomProfileRow, DatabaseProvider, UserRow } from '@greenhouse/db';
import { toErrorMessage } from '@greenhouse/utils/error';
import { logger } from '@greenhouse/utils/logger';
import { connectionManager } from '../ws/connection-manager.js';

const SYSTEM_ACTOR = 'system:agent-governance';
const DEFAULT_INTERVAL_MS = 15 * 60 * 1_000;
const DEFAULT_PAGE_SIZE = 100;
const REVIEW_NOTE_PREFIX = 'Automatic suspension: review deadline elapsed';
const OWNER_NOTE_PREFIX = 'Automatic suspension: owner is disabled and no active backup owner is available';

type GovernanceReason = 'review_due' | 'owner_unavailable';

export interface AgentGovernanceWorkerOptions {
  db: DatabaseProvider;
  intervalMs?: number;
  pageSize?: number;
  skipBootPass?: boolean;
  now?: () => Date;
}

export interface AgentGovernanceWorker {
  runOnce(): Promise<void>;
  stop(): void;
}

function isPublished(profile: CustomProfileRow): boolean {
  return profile.lifecycle_status === 'pilot' || profile.lifecycle_status === 'verified';
}

function reviewNote(profile: CustomProfileRow): string {
  return profile.next_review_at ? `${REVIEW_NOTE_PREFIX} at ${profile.next_review_at}.` : `${REVIEW_NOTE_PREFIX}.`;
}

function governanceReason(profile: CustomProfileRow): GovernanceReason | null {
  if (profile.reviewed_by !== SYSTEM_ACTOR || profile.lifecycle_status !== 'suspended') return null;
  if (profile.lifecycle_note?.startsWith(REVIEW_NOTE_PREFIX)) return 'review_due';
  if (profile.lifecycle_note?.startsWith(OWNER_NOTE_PREFIX)) return 'owner_unavailable';
  return null;
}

function activeUsersById(users: UserRow[]): Map<string, UserRow> {
  return new Map(
    users
      .filter((user) => user.status === 'active' && (user.role === 'team' || user.role === 'super'))
      .map((user) => [user.id, user]),
  );
}

function recipients(profile: CustomProfileRow, users: Map<string, UserRow>): string[] {
  const ids = new Set<string>();
  if (users.has(profile.user_id)) ids.add(profile.user_id);
  if (profile.owner_backup_user_id && users.has(profile.owner_backup_user_id)) {
    ids.add(profile.owner_backup_user_id);
  }
  for (const user of users.values()) {
    if (user.role === 'super') ids.add(user.id);
  }
  return [...ids];
}

function notificationCopy(
  reason: GovernanceReason,
  profile: CustomProfileRow,
): {
  kind: 'agent_review_due' | 'agent_suspended';
  title: string;
  body: string;
} {
  if (reason === 'review_due') {
    return {
      kind: 'agent_review_due',
      title: `${profile.name} needs review`,
      body: 'The Agent was automatically suspended after its review deadline. Review and republish it before reuse.',
    };
  }
  return {
    kind: 'agent_suspended',
    title: `${profile.name} was suspended`,
    body: 'The Agent owner is disabled and no active backup owner is available. Assign continuity ownership before republishing it.',
  };
}

async function notifySuspension(
  db: DatabaseProvider,
  profile: CustomProfileRow,
  reason: GovernanceReason,
  users: Map<string, UserRow>,
): Promise<void> {
  const copy = notificationCopy(reason, profile);
  for (const userId of recipients(profile, users)) {
    try {
      const result = await db.notifications.createWithStatus({
        user_id: userId,
        kind: copy.kind,
        title: copy.title,
        body: copy.body,
        payload: {
          agent_id: `custom:${profile.id}`,
          profile_id: profile.id,
          version: profile.current_version,
          lifecycle_status: profile.lifecycle_status,
          reason,
          transitioned_at: profile.updated_at,
        },
        agent_id: `custom:${profile.id}`,
        dedupe_key: `agent-governance:${reason}:${profile.id}:v${profile.current_version}:${profile.updated_at}`,
      });
      if (result.created) {
        const unread = await db.notifications.countUnread(userId);
        connectionManager.sendToUser(userId, {
          type: 'notification:new',
          notificationId: result.notification.id,
          kind: result.notification.kind,
          title: result.notification.title,
          unread,
        });
      }
    } catch (error) {
      // A failed recipient must not prevent lifecycle governance or the other
      // recipients. The suspended-row recovery pass retries this exact key.
      logger.error('[agent-governance] notification failed', {
        profileId: profile.id,
        userId,
        reason,
        error: toErrorMessage(error),
      });
    }
  }
}

async function notifyContinuityWarning(
  db: DatabaseProvider,
  candidate: CustomProfileOwnershipCandidate,
  users: Map<string, UserRow>,
  ownerStateKey: string,
): Promise<void> {
  const { profile } = candidate;
  const activeBackup = profile.owner_backup_user_id ? users.get(profile.owner_backup_user_id) : undefined;
  if (!activeBackup) return;
  const targetIds = new Set<string>([activeBackup.id]);
  for (const user of users.values()) {
    if (user.role === 'super') targetIds.add(user.id);
  }
  for (const userId of targetIds) {
    try {
      const result = await db.notifications.createWithStatus({
        user_id: userId,
        kind: 'agent_review_due',
        title: `${profile.name} needs an active owner`,
        body: 'The primary owner is disabled. The active backup owner can keep the Agent available, but ownership should be reviewed.',
        payload: {
          agent_id: `custom:${profile.id}`,
          profile_id: profile.id,
          version: profile.current_version,
          reason: 'owner_backup_active',
          owner_user_id: profile.user_id,
          backup_owner_user_id: activeBackup.id,
        },
        agent_id: `custom:${profile.id}`,
        dedupe_key: `agent-governance:owner-backup-active:${profile.id}:v${profile.current_version}:${ownerStateKey}`,
      });
      if (result.created) {
        const unread = await db.notifications.countUnread(userId);
        connectionManager.sendToUser(userId, {
          type: 'notification:new',
          notificationId: result.notification.id,
          kind: result.notification.kind,
          title: result.notification.title,
          unread,
        });
      }
    } catch (error) {
      logger.error('[agent-governance] continuity notification failed', {
        profileId: profile.id,
        userId,
        error: toErrorMessage(error),
      });
    }
  }
}

export async function startAgentGovernanceWorker(
  options: AgentGovernanceWorkerOptions,
): Promise<AgentGovernanceWorker> {
  const { db } = options;
  const pageSize = Math.max(1, Math.min(options.pageSize ?? DEFAULT_PAGE_SIZE, 500));
  const now = options.now ?? (() => new Date());
  let running = false;
  let stopped = false;

  const runOnce = async (): Promise<void> => {
    if (running || stopped) return;
    running = true;
    try {
      let allUsers = new Map<string, UserRow>();
      let users = new Map<string, UserRow>();
      try {
        const rows = await db.users.list();
        allUsers = new Map(rows.map((user) => [user.id, user]));
        users = activeUsersById(rows);
      } catch (error) {
        // State transitions remain safe without notification recipients. A
        // later pass recovers notifications from the system-suspended row.
        logger.error('[agent-governance] active-user scan failed', { error: toErrorMessage(error) });
      }

      const processed = new Set<number>();
      const scanAt = now().toISOString();
      for (;;) {
        let due: CustomProfileRow[];
        try {
          due = await db.customProfiles.listReviewDue(scanAt, pageSize);
        } catch (error) {
          logger.error('[agent-governance] review-due scan failed', { error: toErrorMessage(error) });
          break;
        }
        const unattempted = due.filter((profile) => !processed.has(profile.id));
        if (unattempted.length === 0) break;
        for (const profile of unattempted) {
          processed.add(profile.id);
          try {
            const suspended = await db.customProfiles.transitionLifecycle(profile.id, {
              status: 'suspended',
              actor_user_id: SYSTEM_ACTOR,
              note: reviewNote(profile),
            });
            if (suspended) await notifySuspension(db, suspended, 'review_due', users);
          } catch (error) {
            logger.error('[agent-governance] review-due suspension failed', {
              profileId: profile.id,
              error: toErrorMessage(error),
            });
          }
        }
        // Successful transitions disappear from the next query, giving a
        // stable page without extending the DB service contract. Failed ids
        // stay in `processed`, so a bad row cannot create an infinite loop.
        if (due.length < pageSize) break;
      }

      let afterId = 0;
      for (;;) {
        let page: CustomProfileOwnershipCandidate[];
        try {
          page = await db.customProfiles.listActiveWithOwners(pageSize, afterId);
        } catch (error) {
          logger.error('[agent-governance] ownership scan failed', { afterId, error: toErrorMessage(error) });
          break;
        }
        if (page.length === 0) break;
        afterId = page.at(-1)!.profile.id;

        for (const candidate of page) {
          const { profile } = candidate;
          if (processed.has(profile.id)) continue;

          const recoveredReason = governanceReason(profile);
          if (recoveredReason) {
            await notifySuspension(db, profile, recoveredReason, users);
            continue;
          }
          if (!isPublished(profile) || candidate.owner_status === 'active') continue;
          if (candidate.backup_owner_status === 'active') {
            await notifyContinuityWarning(
              db,
              candidate,
              users,
              allUsers.get(profile.user_id)?.updated_at ?? 'disabled',
            );
            continue;
          }

          try {
            const suspended = await db.customProfiles.transitionLifecycle(profile.id, {
              status: 'suspended',
              actor_user_id: SYSTEM_ACTOR,
              note: `${OWNER_NOTE_PREFIX}.`,
            });
            if (suspended) await notifySuspension(db, suspended, 'owner_unavailable', users);
          } catch (error) {
            logger.error('[agent-governance] owner-continuity suspension failed', {
              profileId: profile.id,
              error: toErrorMessage(error),
            });
          }
        }
        if (page.length < pageSize) break;
      }
    } finally {
      running = false;
    }
  };

  if (!options.skipBootPass) await runOnce();
  const timer = setInterval(
    () => {
      void runOnce().catch((error) =>
        logger.error('[agent-governance] worker pass failed', { error: toErrorMessage(error) }),
      );
    },
    Math.max(options.intervalMs ?? DEFAULT_INTERVAL_MS, 250),
  );
  timer.unref();

  return {
    runOnce,
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
