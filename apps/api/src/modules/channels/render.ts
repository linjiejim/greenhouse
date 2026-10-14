/**
 * The words of a delivered notification, per channel, in the member's language. Pure.
 *
 * - Without previews (the default) a push, an email or an IM message says only who wants what
 *   kind of thing ("Greeny：请你批准一个操作"): a lock screen and a mail server are not private.
 * - With previews it names the subject: the notification's title. The body (what a card asks,
 *   what a reply says) goes along only for categories that are not sensitive.
 * - Every message carries the deep link back to its source, built from the public URL.
 * - Text written by Agents or people is data: escaped in HTML, defused in IM text (WeCom reads
 *   `<a>` in text messages, Feishu `<at>`), never formatted as markup.
 */

import { escapeHtml } from '@greenhouse/utils/html';
import type { NotificationCategory, NotificationKind } from '@greenhouse/db';
import { SENSITIVE } from './settings.js';

export type Locale = 'zh' | 'en';

export interface Rendering {
  locale: Locale;
  category: NotificationCategory;
  kind: NotificationKind;
  /** A needs-you card's kind: approval, login, takeover, question, proposal. */
  requestKind?: string | null;
  /** Who it is from: the Agent's name, the person's who mentioned the member, else the workspace's. */
  from: string;
  workspace: string;
  /** The notification's own title and body. */
  title: string;
  body: string;
  /** Absolute: back to where it happened. */
  link: string;
  previews: boolean;
  /** Notifications folded into this one message (same source, same category, a short window). */
  count: number;
}

const PUSH_TITLE_MAX = 60;
const PUSH_BODY_MAX = 180;
const PUSH_EXCERPT_MAX = 80;
const MESSAGE_BODY_MAX = 2000;

const NEEDS_YOU: Record<Locale, Record<string, string>> = {
  zh: {
    approval: '请你批准一个操作',
    login: '需要你登录一个网站',
    takeover: '需要你接手电脑',
    question: '有个问题想问你',
    proposal: '有个提议等你决定',
  },
  en: {
    approval: 'Needs your approval',
    login: 'Needs you to sign in to a site',
    takeover: 'Needs you to take over the computer',
    question: 'Has a question for you',
    proposal: 'Has a proposal for you',
  },
};

/** What kind of thing happened, without any of its content. */
export function phrase(input: Pick<Rendering, 'locale' | 'category' | 'kind' | 'requestKind'>): string {
  const zh = input.locale === 'zh';
  switch (input.category) {
    case 'needs_you':
      return NEEDS_YOU[input.locale][input.requestKind ?? ''] ?? (zh ? '需要你' : 'Needs you');
    case 'replies':
      return input.kind === 'mention' ? (zh ? '提到了你' : 'Mentioned you') : zh ? '回复了你' : 'Replied to you';
    case 'runs':
      return input.kind === 'run_failed'
        ? zh
          ? '后台运行没能完成'
          : 'A background run did not finish'
        : zh
          ? '后台运行完成了'
          : 'A background run finished';
    case 'other':
      return zh ? '有一条新通知' : 'You have a new notification';
  }
}

function clip(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max
    ? `${chars
        .slice(0, max - 1)
        .join('')
        .trimEnd()}…`
    : text;
}

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

/** WeCom reads `<a href>` and Feishu `<at>` in plain text: angle brackets from others become look-alikes. */
const defuse = (text: string) => text.replace(/</g, '‹').replace(/>/g, '›');

function counted(text: string, input: Pick<Rendering, 'locale' | 'count'>): string {
  if (input.count <= 1) return text;
  return input.locale === 'zh' ? `${text}（共 ${input.count} 条）` : `${text} (${input.count} updates)`;
}

/** The subject line: the notification's title with previews, else who and what kind. */
function headline(input: Rendering): string {
  const subject = input.previews ? oneLine(input.title) : '';
  if (subject) return counted(subject, input);
  const separator = input.locale === 'zh' ? '：' : ': ';
  return counted(`${oneLine(input.from)}${separator}${phrase(input)}`, input);
}

/** The body travels only with previews on, and never for a sensitive category. */
function detail(input: Rendering): string {
  return input.previews && !SENSITIVE.has(input.category) ? input.body.trim() : '';
}

export function renderPush(input: Rendering): { title: string; body: string } {
  const title = clip(oneLine(input.from) || oneLine(input.workspace), PUSH_TITLE_MAX);
  const subject = input.previews ? oneLine(input.title) : '';
  const excerpt = detail(input) ? clip(oneLine(detail(input)), PUSH_EXCERPT_MAX) : '';
  const text = subject ? (excerpt ? `${subject} · ${excerpt}` : subject) : phrase(input);
  return { title, body: clip(counted(text, input), PUSH_BODY_MAX) };
}

export function renderEmail(input: Rendering): { subject: string; text: string; html: string } {
  const zh = input.locale === 'zh';
  const subject = clip(headline(input), 200);
  const body = clip(detail(input), MESSAGE_BODY_MAX);
  const open = zh ? '打开查看' : 'Open it';
  const footer = zh
    ? `这封邮件来自 ${oneLine(input.workspace)}。不想再收到，可以在「设置 → 通知」里关掉邮件。`
    : `Sent by ${oneLine(input.workspace)}. To stop these emails, turn email off in Settings → Notifications.`;
  const text = [subject, body, `${open}: ${input.link}`, '—', footer].filter(Boolean).join('\n\n');
  const paragraphs = body
    .split(/\n{2,}/)
    .filter(Boolean)
    .map((part) => `<p>${escapeHtml(part).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
  const html = [
    '<!doctype html>',
    `<html lang="${zh ? 'zh-CN' : 'en'}"><head><meta charset="utf-8"><title>${escapeHtml(subject)}</title></head><body>`,
    `<p><strong>${escapeHtml(subject)}</strong></p>`,
    paragraphs,
    `<p><a href="${escapeHtml(input.link)}">${open}</a></p>`,
    `<p><small>${escapeHtml(footer)}</small></p>`,
    '</body></html>',
  ]
    .filter(Boolean)
    .join('\n');
  return { subject, text, html };
}

/** A Feishu or WeCom text message: plain text, the link on its own line. */
export function renderIm(input: Rendering): string {
  const body = clip(detail(input), MESSAGE_BODY_MAX);
  return [defuse(headline(input)), defuse(body), input.link].filter(Boolean).join('\n');
}

/** The web app's route back to a notification's source (hash routes, docs/product/prd.md §6.4). */
export function linkPath(target: { targetType: string | null; targetId: string | null; runId: string | null }): string {
  const id = target.targetId ? encodeURIComponent(target.targetId) : null;
  if (id && target.targetType === 'conversation') return `/c/${id}`;
  if (id && target.targetType === 'run') return `/runs/${id}`;
  if (id && target.targetType === 'agent') return `/agents/${id}`;
  if (id && target.targetType === 'app') return `/apps/${id}`;
  if (id && target.targetType === 'doc') return `/knowledge/${id}`;
  if (id && target.targetType === 'folder') return `/knowledge/folder/${id}`;
  if (target.runId) return `/runs/${encodeURIComponent(target.runId)}`;
  return '/notifications';
}

export const deepLink = (publicUrl: string, path: string) => `${publicUrl.replace(/\/+$/, '')}/#${path}`;
