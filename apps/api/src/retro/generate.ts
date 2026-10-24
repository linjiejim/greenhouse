/**
 * Monthly retro (复盘) — collect the aggregates, ask for next month's
 * suggestions, write the team knowledge doc "YYYY-MM 复盘" into the team folder
 * "复盘" (created when missing), and tell every active super it is ready.
 *
 * Idempotent per month: the doc id is fixed per month (`team-retro-YYYY-MM`),
 * so a second run updates the same doc (a new version in its history) instead
 * of adding another. A doc someone moved or archived stays moved; archived ones
 * are published again because a regenerated retro is meant to be read.
 *
 * Callers: the scheduled job (09:00 on the 1st, workspace time — the month that
 * just ended) and the super-only "生成本月复盘" button (the current month).
 */

import type { DatabaseProvider, KnowledgeDoc, UserRow } from '@greenhouse/db';
import { entityUrl } from '@greenhouse/types/entity-links';
import type { RetroResult } from '@greenhouse/types/hub-context';
import { logger } from '@greenhouse/utils/logger';
import { toErrorMessage } from '@greenhouse/utils/error';
import { queueMobilePush } from '../notifications/push/queue.js';
import { connectionManager } from '../ws/connection-manager.js';
import { workspaceTimeZone } from '../hub-context/settings.js';
import { collectRetroAggregates, monthKey, retroMonth, type RetroAggregates } from './aggregate.js';
import { renderRetroMarkdown, retroTitle, RETRO_FOLDER_NAME, type RetroSuggestions } from './render.js';
import { suggestNextMonth } from './suggest.js';

export interface GenerateRetroInput {
  db: DatabaseProvider;
  /** `YYYY-MM`; defaults to the current UTC month. */
  month?: string;
  /** The super who asked; the scheduled job passes none (the earliest active super authors it). */
  actorId?: string | null;
  now?: Date;
  /** Test seam; defaults to the metered model call. */
  suggest?: (db: DatabaseProvider, aggregates: RetroAggregates) => Promise<RetroSuggestions>;
}

export class RetroInputError extends Error {}

export function retroDocId(month: string): string {
  return `team-retro-${month}`;
}

async function activeSupers(db: DatabaseProvider): Promise<UserRow[]> {
  return (await db.users.list())
    .filter((user) => user.role === 'super' && user.status === 'active')
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

async function ensureRetroFolder(db: DatabaseProvider, authorId: string | null): Promise<string> {
  const roots = await db.drive.listFolders({ scope: 'kb', parent_id: null, visibility: 'team' });
  const existing = roots.find((folder) => folder.name === RETRO_FOLDER_NAME);
  if (existing) return existing.id;
  const created = await db.drive.createFolder({
    scope: 'kb',
    parent_id: null,
    name: RETRO_FOLDER_NAME,
    visibility: 'team',
    created_by: authorId,
  });
  return created.id;
}

async function writeDoc(
  db: DatabaseProvider,
  input: { month: string; content: string; authorId: string | null },
): Promise<{ doc: KnowledgeDoc; created: boolean }> {
  const docId = retroDocId(input.month);
  const title = retroTitle(input.month);
  const existing = await db.knowledgeBase.get(docId, 'shared');
  if (existing) {
    const updated = await db.knowledgeBase.update(
      existing.id,
      { title, content: input.content, ...(existing.status !== 'published' ? { status: 'published' } : {}) },
      input.authorId,
      'Regenerated the monthly retro',
    );
    return { doc: updated ?? existing, created: false };
  }
  const folderId = await ensureRetroFolder(db, input.authorId);
  const doc = await db.knowledgeBase.create({
    doc_id: docId,
    scope: 'shared',
    title,
    content: input.content,
    visibility: 'team',
    status: 'published',
    folder_id: folderId,
    tags: [RETRO_FOLDER_NAME],
    meta: { retro_month: input.month },
    created_by: input.authorId ?? undefined,
    owner_user_id: input.authorId,
  });
  return { doc, created: true };
}

async function notifySupers(db: DatabaseProvider, supers: UserRow[], result: RetroResult, doc: KnowledgeDoc) {
  for (const recipient of supers) {
    try {
      const en = recipient.locale === 'en';
      const created = await db.notifications.createWithStatus({
        user_id: recipient.id,
        kind: 'system',
        title: en ? `${result.month} retro is ready` : `${result.month} 复盘已生成`,
        body: en
          ? `Usage, agents' writes, issues & requests and spend for ${result.month} are in the knowledge base (folder 复盘).`
          : `${result.month} 的模块使用、Agent 写入、问题与需求和花费已写进知识库「复盘」文件夹。`,
        payload: {
          url: result.url,
          retro_month: result.month,
          doc_id: result.doc_id,
          suggestions: result.suggestions,
        },
        // One notice per generation: a regenerated retro is news again.
        dedupe_key: `monthly-retro:${result.month}:${doc.updated_at}`,
      });
      await queueMobilePush(db, created.notification);
      if (!created.created) continue;
      connectionManager.sendToUser(recipient.id, {
        type: 'notification:new',
        notificationId: created.notification.id,
        kind: created.notification.kind,
        title: created.notification.title,
        unread: await db.notifications.countUnread(recipient.id),
        runId: created.notification.run_id,
        interruptId: created.notification.interrupt_id,
      });
    } catch (err) {
      // A missed notice never undoes the retro.
      logger.warn('[retro] could not notify an administrator', { error: toErrorMessage(err) });
    }
  }
}

export async function generateMonthlyRetro(input: GenerateRetroInput): Promise<RetroResult> {
  const now = input.now ?? new Date();
  const monthId = input.month ?? monthKey(now);
  const month = retroMonth(monthId);
  if (!month) throw new RetroInputError(`month must be YYYY-MM, got "${monthId}"`);
  if (Date.parse(month.start) > now.getTime()) throw new RetroInputError(`${monthId} has not started yet`);

  const timeZone = await workspaceTimeZone();
  const aggregates = await collectRetroAggregates(input.db, month);
  const suggestions = await (input.suggest ?? suggestNextMonth)(input.db, aggregates);
  const content = renderRetroMarkdown({ aggregates, suggestions, generatedAt: now, timeZone });

  const supers = await activeSupers(input.db);
  const authorId = input.actorId ?? supers[0]?.id ?? null;
  const { doc, created } = await writeDoc(input.db, { month: monthId, content, authorId });

  const result: RetroResult = {
    month: monthId,
    doc_id: doc.doc_id,
    url: entityUrl({ kind: 'kb_doc', id: doc.id, slug: doc.doc_id }),
    created,
    suggestions: suggestions.ok ? 'included' : 'skipped',
    skipped_reason: suggestions.ok ? null : suggestions.reason,
  };
  await notifySupers(input.db, supers, result, doc);
  logger.info('[retro] monthly retro written', {
    month: monthId,
    doc: doc.doc_id,
    created,
    suggestions: result.suggestions,
  });
  return result;
}
