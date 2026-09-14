/**
 * Knowledge-base comment / @-mention notifications via WeCom.
 *
 * Recipients = @-mentioned users + doc participants (author + prior commenters),
 * de-duped, minus the actor. A WeCom group bot can't @-ping individuals (that
 * needs the `text` msgtype + WeCom userids), so we name people in the markdown
 * and rely on the canonical deeplink. No-op — never throws, never fabricates —
 * when no webhook is configured (capability-must-be-real rule).
 *
 * Webhook: KNOWLEDGE_WECOM_WEBHOOK_URL, falling back to the sync bot
 * (SYNC_WECOM_WEBHOOK_URL). Absolute links use APP_BASE_URL when set, else the
 * bare hash route.
 *
 * Recipients who have BOUND their WeCom account additionally get the same card
 * as a direct message. The group post is not replaced by it: the room is where
 * the team sees activity, the DM is where the person being asked sees it. Each
 * leg is independent — an unconfigured group webhook does not stop the DMs, and
 * an unbound recipient simply does not get one.
 */

import { sendWeComMarkdown } from '@greenhouse/utils/wecom';
import { logger } from '@greenhouse/utils/logger';
import type { DatabaseProvider, KnowledgeDocRow } from '@greenhouse/db';
import { isWeComConfigured, sendAppMarkdown } from '../wecom/client.js';
import { WECOM_PROVIDER } from '../routes/wecom-oauth.js';
import { isFeishuConfigured, sendCardMarkdown } from '../feishu/client.js';
import { FEISHU_PROVIDER } from '../routes/feishu-oauth.js';

/** Extract mentioned user ids from `[@nickname](user:<id>)` markdown links. */
export function extractMentionIds(content: string): string[] {
  const ids = new Set<string>();
  for (const m of content.matchAll(/\(user:([^)]+)\)/g)) {
    const id = m[1]?.trim();
    if (id) ids.add(id);
  }
  return [...ids];
}

/** Canonical absolute (or hash-relative) deeplink for a KB doc. */
export function kbDocDeeplink(id: number, slug: string): string {
  const base = (process.env.APP_BASE_URL ?? '').replace(/\/$/, '');
  return `${base}/#/knowledge/doc/${id}-${slug}`;
}

export async function notifyKbComment(
  db: DatabaseProvider,
  opts: { doc: KnowledgeDocRow; actorUserId: string; actorNickname: string; commentContent: string },
): Promise<void> {
  const webhook = process.env.KNOWLEDGE_WECOM_WEBHOOK_URL || process.env.SYNC_WECOM_WEBHOOK_URL;
  // Neither channel configured → nothing to do. Checked together so the group
  // webhook is no longer a precondition for personal delivery.
  if (!webhook && !isWeComConfigured()) return;

  const mentionedIds = extractMentionIds(opts.commentContent);
  const recipients = new Set<string>(mentionedIds);
  if (opts.doc.owner_user_id) recipients.add(opts.doc.owner_user_id);
  if (opts.doc.created_by) recipients.add(opts.doc.created_by);
  for (const id of await db.kbComments.commenterIds(opts.doc.id)) recipients.add(id);
  recipients.delete(opts.actorUserId);
  if (recipients.size === 0) return; // nobody to notify

  // Name the @-mentioned people (best-effort nickname resolution).
  const mentionNames: string[] = [];
  for (const id of mentionedIds) {
    if (id === opts.actorUserId) continue;
    const u = await db.users.getById(id).catch(() => undefined);
    if (u) mentionNames.push(u.nickname);
  }

  const link = kbDocDeeplink(opts.doc.id, opts.doc.doc_id);
  const preview = opts.commentContent.replace(/\s+/g, ' ').trim().slice(0, 120);
  const mentionLine = mentionNames.length ? `\n> 提到:${mentionNames.map((n) => `@${n}`).join('、')}` : '';
  const md = `**📝 知识库评论** ${opts.actorNickname} 评论了《${opts.doc.title}》${mentionLine}\n> ${preview}\n[打开文档](${link})`;

  if (webhook) {
    const sent = await sendWeComMarkdown(webhook, md);
    if (!sent.ok) logger.warn(`KB comment WeCom notify failed (${sent.status ?? '-'}): ${sent.error ?? ''}`);
  }

  await notifyRecipientsDirectly(db, [...recipients], md);
}

/**
 * Direct-message the recipients who have bound WeCom and/or Feishu.
 *
 * Best effort per person and per channel: one unbound colleague, or one failed
 * send, must not stop the rest — this runs on the success path of a comment
 * that is already saved. Both DM legs are independent additions on top of the
 * group webhook; whichever apps are configured and bound deliver.
 */
async function notifyRecipientsDirectly(db: DatabaseProvider, recipients: string[], markdown: string): Promise<void> {
  const wecom = isWeComConfigured();
  const feishu = isFeishuConfigured();
  if (!wecom && !feishu) return;
  for (const userId of recipients) {
    if (wecom) {
      try {
        const binding = await db.providerTokens.get(userId, WECOM_PROVIDER, null);
        if (binding?.provider_user_id) {
          const sent = await sendAppMarkdown(binding.provider_user_id, markdown);
          if (!sent.ok) logger.warn(`KB comment WeCom DM failed for ${userId}: ${sent.error ?? ''}`);
        }
      } catch (err) {
        logger.warn(`KB comment WeCom DM threw for ${userId}: ${String(err)}`);
      }
    }
    if (feishu) {
      try {
        const binding = await db.providerTokens.get(userId, FEISHU_PROVIDER, null);
        if (binding?.provider_user_id) {
          const sent = await sendCardMarkdown(binding.provider_user_id, markdown);
          if (!sent.ok) logger.warn(`KB comment Feishu DM failed for ${userId}: ${sent.error ?? ''}`);
        }
      } catch (err) {
        logger.warn(`KB comment Feishu DM threw for ${userId}: ${String(err)}`);
      }
    }
  }
}
