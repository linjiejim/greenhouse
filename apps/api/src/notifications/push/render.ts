/**
 * The words of a mobile push (docs/specs/20261010-mobile-push.md §2.1) — pure,
 * in the account's language.
 *
 * Title: the Bot's name (the workspace's name when no Bot speaks). Body: by
 * default only *what kind of thing* happened ("请你批准一个操作") — never the
 * card's details, the task's name or the reply's words: a lock screen is public.
 * With the device's "show preview" switch on, the body names the subject
 * (`subject`: the approval phrase, the site, the task's title, the scheduled
 * task's name) and, where there is one, the first words (`excerpt`).
 */

import type { BotRequestKind } from '@greenhouse/types/bots';
import type { BotsLocale } from '../../bots/engine/copy.js';
import type { PushEnvelope } from './policy.js';

/** How much of a reply / a result summary a preview shows. */
export const PUSH_EXCERPT_CHARS = 80;
/** Hard caps that keep a message far below Expo's 4 KB (title + body + data). */
const TITLE_MAX = 60;
const BODY_MAX = 180;

export interface PushRenderInput {
  locale: BotsLocale;
  envelope: PushEnvelope;
  /** The device's "show preview" switch. */
  preview: boolean;
  botName: string | null;
  /** Title when no Bot speaks (the workspace's product name). */
  fallbackTitle: string;
  /** needs_you: the card's subject · done: the task's title / the scheduled task's name. */
  subject?: string | null;
  /** done (scheduled task): the result summary · replies: the reply. Raw chat markdown is fine. */
  excerpt?: string | null;
}

const NEEDS_YOU: Record<BotsLocale, Record<BotRequestKind, string>> = {
  zh: {
    approval: '请你批准一个操作',
    login: '需要你登录一个网站',
    takeover: '需要你接手电脑',
    bot_create: '提议新建一个 Bot',
    task_start: '提议一个后台任务',
    instructions_update: '提议修改工作说明',
  },
  en: {
    approval: 'Needs your approval',
    login: 'Needs you to sign in to a site',
    takeover: 'Needs you to take over the computer',
    bot_create: 'Proposes a new Bot',
    task_start: 'Proposes a background task',
    instructions_update: 'Proposes a change to its instructions',
  },
};

function needsYouPreview(l: BotsLocale, kind: BotRequestKind, subject: string): string {
  if (l === 'zh') {
    switch (kind) {
      case 'approval':
        return `请你批准：${subject}`;
      case 'login':
        return `需要你登录 ${subject}`;
      case 'takeover':
        return `需要你接手电脑：${subject}`;
      case 'bot_create':
        return `提议新建「${subject}」`;
      case 'task_start':
        return `提议后台任务「${subject}」`;
      case 'instructions_update':
        return `提议修改工作说明：${subject}`;
    }
  }
  switch (kind) {
    case 'approval':
      return `Asks to ${subject}`;
    case 'login':
      return `Needs you to sign in to ${subject}`;
    case 'takeover':
      return `Needs you to take over the computer: ${subject}`;
    case 'bot_create':
      return `Proposes the new Bot “${subject}”`;
    case 'task_start':
      return `Proposes the background task “${subject}”`;
    case 'instructions_update':
      return `Proposes a change to its instructions: ${subject}`;
  }
}

/**
 * Chat markdown → one plain line of at most `max` characters. Fenced blocks (code,
 * tables-as-data, charts, diagrams…) say nothing in one line, so they are dropped
 * rather than flattened; a reply that is only blocks has no excerpt.
 */
export function excerptOf(text: string, max = PUSH_EXCERPT_CHARS): string {
  const plain = text
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    // emphasis / code marks go without a trace (CJK text has no spaces to keep);
    // heading, quote and table marks separate words
    .replace(/\*\*|__|~~|\*|`/g, '')
    .replace(/[#>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clip(plain, max);
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

export function renderPush(input: PushRenderInput): { title: string; body: string } {
  const { locale: l, envelope, preview } = input;
  const title = clip((input.botName ?? '').trim() || input.fallbackTitle, TITLE_MAX);
  const subject = preview ? (input.subject ?? '').replace(/\s+/g, ' ').trim() : '';
  const excerpt = preview && input.excerpt ? excerptOf(input.excerpt) : '';
  let body: string;

  if (envelope.k === 'needs_you') {
    const kind = envelope.request_kind ?? 'approval';
    body = subject ? needsYouPreview(l, kind, subject) : NEEDS_YOU[l][kind];
  } else if (envelope.k === 'replies') {
    body = excerpt || (l === 'zh' ? '回复了你' : 'Replied to you');
  } else if (envelope.open === 'bots') {
    // a Bot's background task
    const ok = envelope.ok !== false;
    if (subject)
      body =
        l === 'zh'
          ? `「${subject}」${ok ? '完成了' : '没能完成'}`
          : `“${subject}” ${ok ? 'finished' : "didn't finish"}`;
    else if (l === 'zh') body = ok ? '后台任务完成了' : '后台任务没能完成';
    else body = ok ? 'Background task finished' : "Background task didn't finish";
  } else {
    // a scheduled task's result
    const ok = envelope.ok !== false;
    if (subject && ok)
      body =
        l === 'zh'
          ? `「${subject}」${excerpt ? `：${excerpt}` : '完成了'}`
          : `“${subject}”${excerpt ? `: ${excerpt}` : ' finished'}`;
    else if (subject) body = l === 'zh' ? `「${subject}」失败了` : `“${subject}” failed`;
    else if (l === 'zh') body = ok ? '定时任务完成了' : '定时任务失败了';
    else body = ok ? 'Scheduled task finished' : 'Scheduled task failed';
  }
  return { title, body: clip(body, BODY_MAX) };
}

/** The settings page's test push. */
export function renderTestPush(l: BotsLocale, fallbackTitle: string): { title: string; body: string } {
  return {
    title: clip(fallbackTitle, TITLE_MAX),
    body: l === 'zh' ? '这是一条测试通知：推送已经接通。' : 'This is a test notification — pushes reach this phone.',
  };
}
