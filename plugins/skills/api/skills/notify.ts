/**
 * Quarantine notification for admins — WeCom group bot only.
 *
 * There is deliberately no in-app inbox here. A general unread inbox is
 * platform-level infrastructure filed as its own project (see the Automation
 * section of apps/api/src/AGENTS.md); building half of one for a single module
 * would leave the future inbox with a parallel implementation to migrate. The
 * second channel is the SkillHub UI itself, which already loads the whole
 * catalog and can therefore derive a "needs review" count client-side without
 * any new endpoint (spec D7).
 *
 * Webhook: SKILLS_WECOM_WEBHOOK_URL. Unconfigured → silent no-op, never a fake
 * notification (capability-must-be-real rule). Never throws: a failed notify
 * must not turn a completed publish into an error.
 */

import { pluginPagePath } from '@greenhouse/types/client-routes';
import { notificationWebhookTransport } from '@greenhouse/api/extension-kit';
import { logger } from '@greenhouse/api/extension-kit';
import type { SkillRow } from '../schema.js';
import type { ScanFinding } from './scanner.js';

/** The Skills page of the universal client (it has no per-skill address; the message names the skill). */
export function skillsPageUrl(): string {
  const base = (process.env.PUBLIC_BASE_URL ?? '').replace(/\/$/, '');
  return `${base}${pluginPagePath('skills', 'skills')}`;
}

export async function notifySuspiciousSkill(opts: {
  skill: SkillRow;
  version: string;
  findings: ScanFinding[];
}): Promise<void> {
  const webhook = process.env.SKILLS_WECOM_WEBHOOK_URL;
  if (!webhook) return;
  const transport = notificationWebhookTransport(webhook);
  if (!transport?.sendWebhook) return; // disabled/unconfigured adapter never sends

  const { skill, version, findings } = opts;
  const rules = findings
    .slice(0, 5)
    .map((f) => `> · ${f.rule}${f.path ? ` (${f.path})` : ''}：${f.excerpt}`)
    .join('\n');
  const more = findings.length > 5 ? `\n> …另有 ${findings.length - 5} 条` : '';
  const md = [
    `**⚠️ 技能待审核** \`${skill.name}\` v${version} 被安全扫描判定为可疑，已暂停下载。`,
    `> 发布者:${skill.owner_user_id}`,
    rules + more,
    `[打开技能](${skillsPageUrl()})`,
  ].join('\n');

  const sent = await transport.sendWebhook(webhook, md);
  if (!sent.ok) logger.warn(`[skills] quarantine WeCom notify failed (${sent.status ?? '-'}): ${sent.error ?? ''}`);
}
