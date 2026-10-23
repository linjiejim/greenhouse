/**
 * The words of a mobile push — pure, in the account's language.
 *
 * Title: the workspace's product name. Body: by default only *what kind of
 * thing* happened ("有一项需要你处理") — never the notification's title or body:
 * a lock screen is public. With the phone's "show preview" switch on, the body is
 * the notification's title (server-written copy such as "Daily report completed").
 * The notification body (an automation's summary, an error) never leaves.
 */

import type { PushCategory } from '@greenhouse/types/push';

export type PushLocale = 'zh' | 'en';

/** Hard caps that keep a message far below Expo's 4 KB (title + body + data). */
const TITLE_MAX = 60;
const BODY_MAX = 140;

export function pushLocale(locale: string | null | undefined): PushLocale {
  return locale?.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

const GENERIC: Record<PushLocale, Record<PushCategory | 'done_failed', string>> = {
  zh: {
    needs_you: '有一项需要你处理',
    done: '一项任务完成了',
    done_failed: '一项任务需要你查看',
    other: '你有一条新通知',
  },
  en: {
    needs_you: 'Something needs your attention',
    done: 'A task finished',
    done_failed: 'A task needs your review',
    other: 'You have a new notification',
  },
};

export function clip(text: string, max: number): string {
  const chars = Array.from(text.replace(/\s+/g, ' ').trim());
  return chars.length > max
    ? `${chars
        .slice(0, max - 1)
        .join('')
        .trimEnd()}…`
    : chars.join('');
}

export function renderPush(input: {
  locale: PushLocale;
  category: PushCategory;
  /** The notification's kind (a failed run reads differently from a finished one). */
  kind: string;
  /** The phone's "show preview" switch. */
  preview: boolean;
  /** The notification's title, shown only with previews on. */
  subject: string;
  productName: string;
}): { title: string; body: string } {
  const title = clip(input.productName || 'Greenhouse', TITLE_MAX);
  const subject = input.preview ? clip(input.subject, BODY_MAX) : '';
  if (subject) return { title, body: subject };
  const key = input.category === 'done' && input.kind === 'runtime_failed' ? 'done_failed' : input.category;
  return { title, body: GENERIC[input.locale][key] };
}

/** The settings page's test push. */
export function renderTestPush(locale: PushLocale, productName: string): { title: string; body: string } {
  return {
    title: clip(productName || 'Greenhouse', TITLE_MAX),
    body:
      locale === 'zh' ? '这是一条测试通知：推送已经接通。' : 'This is a test notification — pushes reach this phone.',
  };
}
