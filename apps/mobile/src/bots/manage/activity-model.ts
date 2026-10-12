/**
 * The profile's Activity tab, as pure rules (root vitest: ./activity-model.test.ts):
 * how one thing an Agent did reads (`BotActivityItem` from `GET /api/bots/:id/activity` —
 * a platform action it took for its owner, a password-vault use, a background task;
 * never message content) and the 30-day usage summary (`BotUsageView`).
 * Spec docs/specs/20261011-agent-first-class.md P3d.
 */

import type { TFunction, TranslationKey } from '../../lib/i18n';
import type { BotActivityItem, BotUsageView } from '../../shared/bots';
import type { BadgeTone } from '../../ui/list';
import type { IconName } from '../../ui/core';

/** Apps whose actions the member knows by name (the platform kernel's: apps/api/src/platform/manifests). */
const APP_NAMES: Record<string, TranslationKey> = {
  projects: 'bots.profile.appProjects',
  tables: 'bots.profile.appTables',
  knowledge: 'bots.profile.appKnowledge',
};

const APP_ICONS: Record<string, IconName> = { projects: 'checklist', tables: 'table', knowledge: 'book' };

/** vault_access_log.action → what the Agent did with a saved password. */
const VAULT_ACTIONS: Record<string, TranslationKey> = {
  fill_login: 'bots.profile.vaultFillLogin',
  fill_totp: 'bots.profile.vaultFillTotp',
  secure_login: 'bots.profile.vaultSecureLogin',
};

type Outcome = { key: TranslationKey; tone: BadgeTone };

const DONE: Outcome = { key: 'bots.profile.outcomeDone', tone: 'green' };
const DENIED: Outcome = { key: 'bots.profile.outcomeDenied', tone: 'orange' };
const FAILED: Outcome = { key: 'bots.profile.outcomeFailed', tone: 'red' };
const RUNNING: Outcome = { key: 'bots.profile.outcomeRunning', tone: 'blue' };

/** Each kind's outcomes (platform_audit_events.result · vault_access_log.outcome · bot task status). */
const OUTCOMES: Record<BotActivityItem['kind'], Record<string, Outcome>> = {
  action: { success: DONE, denied: DENIED, error: FAILED },
  vault: {
    filled: { key: 'bots.profile.outcomeFilled', tone: 'green' },
    denied: DENIED,
    origin_mismatch: { key: 'bots.profile.outcomeWrongSite', tone: 'red' },
    failed: FAILED,
  },
  task: {
    queued: RUNNING,
    running: RUNNING,
    waiting: RUNNING,
    succeeded: DONE,
    failed: FAILED,
    canceled: { key: 'bots.profile.outcomeCanceled', tone: 'neutral' },
    interrupted: { key: 'bots.profile.outcomeInterrupted', tone: 'orange' },
  },
};

/** `projects.updateTask` → app `projects`, action `updateTask` (no dot: all of it is the action). */
export function splitAction(title: string): { app: string; action: string } {
  const dot = title.indexOf('.');
  return dot < 0 ? { app: '', action: title } : { app: title.slice(0, dot), action: title.slice(dot + 1) };
}

/** `updateTask` / `add_comment` → "Update task" / "Add comment". */
export function actionWords(action: string): string {
  const words = action
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : '';
}

/** The row's line: "Projects · Update task", "Filled a sign-in", or a background task's title. */
export function activityTitle(item: BotActivityItem, t: TFunction): string {
  if (item.kind === 'vault') {
    const key = VAULT_ACTIONS[item.title];
    return key ? t(key) : t('bots.profile.vaultUsed');
  }
  if (item.kind === 'task') return item.title.trim() || t('bots.profile.taskUntitled');
  const { app, action } = splitAction(item.title);
  const appKey = APP_NAMES[app];
  const appName = appKey ? t(appKey) : app ? app[0].toUpperCase() + app.slice(1) : '';
  const words = actionWords(action);
  return [appName, words].filter(Boolean).join(' · ') || item.title;
}

export function activityIcon(item: Pick<BotActivityItem, 'kind' | 'title'>): IconName {
  if (item.kind === 'vault') return 'key';
  if (item.kind === 'task') return 'hourglass';
  return APP_ICONS[splitAction(item.title).app] ?? 'wrench';
}

/** The outcome badge, or null for one this app does not know (the row then shows none). */
export function activityOutcome(item: Pick<BotActivityItem, 'kind' | 'outcome'>): Outcome | null {
  return OUTCOMES[item.kind]?.[item.outcome] ?? null;
}

/** The usage summary: model calls, tokens (in + out), and on how many days it worked. */
export function usageSummary(view: BotUsageView): { calls: number; tokens: number; activeDays: number } {
  return {
    calls: view.totals.calls,
    tokens: view.totals.input_tokens + view.totals.output_tokens,
    activeDays: view.days.filter((day) => day.calls > 0).length,
  };
}
