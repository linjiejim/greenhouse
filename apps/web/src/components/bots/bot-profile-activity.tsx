/**
 * An Agent's usage and activity — the profile drawer's Usage and Activity tabs
 * (spec 20261011-agent-first-class P3d). Owner-only reads:
 * - Usage: `GET /api/bots/:id/usage?days=30` — totals and one bar per active day
 *   (calls and tokens of the Agent's work — for a public Agent, everyone's use of it).
 * - Activity: `GET /api/bots/:id/activity` — platform actions it took, password
 *   uses and background tasks, newest first; never message content. A row that
 *   happened in a conversation opens it.
 */

import { useEffect, useState } from 'react';
import type { BotActivityItem, BotUsageView } from '@greenhouse/types/bots';
import { Spinner, Tag, type TagTone } from '../ui';
import { ArrowUpRight, Key, ListTodo, Wrench, type LucideIcon } from '../../lib/icons';
import { useT, type TranslationKey } from '../../lib/i18n';
import { formatDate, formatDay, formatTokens } from '../../lib/utils';
import { fetchBotActivity, fetchBotUsage } from '../../lib/api/bots';
import { PanelSection } from './bots-side-panel';
import { botsConversationHash } from './navigation';

const USAGE_DAYS = 30;

type Load<T> = { state: 'loading' } | { state: 'failed' } | { state: 'ready'; data: T };

/** Load `fetch(botId)` again whenever the Agent changes; a late answer for the previous one is dropped. */
function useBotResource<T>(botId: string, fetch: (id: string) => Promise<T>): Load<T> {
  const [load, setLoad] = useState<Load<T> & { botId: string }>({ state: 'loading', botId });
  useEffect(() => {
    let cancelled = false;
    setLoad({ state: 'loading', botId });
    fetch(botId).then(
      (data) => !cancelled && setLoad({ state: 'ready', data, botId }),
      () => !cancelled && setLoad({ state: 'failed', botId }),
    );
    return () => {
      cancelled = true;
    };
  }, [botId, fetch]);
  return load.botId === botId ? load : { state: 'loading' };
}

const loadUsage = (id: string) => fetchBotUsage(id, USAGE_DAYS);
const loadActivity = (id: string) => fetchBotActivity(id);

/** A UTC calendar day (`YYYY-MM-DD`) shown as the same day in any time zone. */
function usageDay(day: string): string {
  return formatDay(`${day}T12:00:00Z`);
}

export function BotUsagePanel({ botId, name, isPublic = false }: { botId: string; name: string; isPublic?: boolean }) {
  const t = useT();
  const usage = useBotResource<BotUsageView>(botId, loadUsage);

  return (
    <PanelSection
      title={t('bots.profile.usageTitle')}
      // A public Agent's usage counts everyone who talks to it (P4, D38).
      hint={t(isPublic ? 'bots.profile.usageHintPublic' : 'bots.profile.usageHint', { name })}
    >
      {usage.state === 'loading' ? (
        <Spinner className="h-4 w-4 text-fg-faint" />
      ) : usage.state === 'failed' ? (
        <p className="text-xs text-danger">{t('bots.profile.usageFailed')}</p>
      ) : (
        <UsageBody usage={usage.data} />
      )}
    </PanelSection>
  );
}

function UsageBody({ usage }: { usage: BotUsageView }) {
  const t = useT();
  const days = usage.days
    .filter((day) => day.calls > 0 || day.input_tokens + day.output_tokens > 0)
    .sort((a, b) => b.day.localeCompare(a.day));
  const peak = Math.max(1, ...days.map((day) => day.input_tokens + day.output_tokens));
  const totals: Array<{ key: TranslationKey; value: string }> = [
    { key: 'bots.profile.usageCalls', value: String(usage.totals.calls) },
    { key: 'bots.profile.usageInput', value: formatTokens(usage.totals.input_tokens) },
    { key: 'bots.profile.usageOutput', value: formatTokens(usage.totals.output_tokens) },
  ];
  return (
    <div className="space-y-3" data-testid="bots-profile-usage">
      <dl className="grid grid-cols-3 gap-2">
        {totals.map((total) => (
          <div key={total.key} className="rounded-md border border-edge bg-surface-raised px-2 py-1.5">
            <dt className="truncate text-[10px] text-fg-faint" title={t(total.key)}>
              {t(total.key)}
            </dt>
            <dd className="text-sm font-semibold text-fg">{total.value}</dd>
          </div>
        ))}
      </dl>
      {days.length === 0 ? (
        <p className="text-xs text-fg-faint">{t('bots.profile.usageEmpty')}</p>
      ) : (
        <div>
          <h4 className="mb-1 text-[11px] font-medium text-fg-muted">{t('bots.profile.usageByDay')}</h4>
          <ul className="space-y-1.5" data-testid="bots-profile-usage-days">
            {days.map((day) => {
              const tokens = day.input_tokens + day.output_tokens;
              return (
                <li key={day.day} className="text-[11px]" data-day={day.day}>
                  <div className="flex items-baseline gap-2">
                    <span className="w-24 flex-shrink-0 text-fg-secondary">{usageDay(day.day)}</span>
                    <span className="min-w-0 flex-1 truncate text-fg-muted">
                      {t('bots.profile.usageDay', { calls: day.calls, tokens: formatTokens(tokens) })}
                      {day.sessions > 0 && ` · ${t('bots.profile.usageDaySessions', { count: day.sessions })}`}
                    </span>
                  </div>
                  <div className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-surface-sunken" aria-hidden="true">
                    <div
                      className="h-full rounded-full bg-primary-500"
                      style={{ width: `${Math.max(2, Math.round((tokens / peak) * 100))}%` }}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

const KIND_ICON: Record<BotActivityItem['kind'], LucideIcon> = { action: Wrench, vault: Key, task: ListTodo };

const KIND_LABEL: Record<BotActivityItem['kind'], TranslationKey> = {
  action: 'bots.profile.activityKind_action',
  vault: 'bots.profile.activityKind_vault',
  task: 'bots.profile.activityKind_task',
};

/** Known outcomes (platform action results, vault fill results, task states) as words and a tone. */
const OUTCOME: Record<string, { key: TranslationKey; tone: TagTone }> = {
  success: { key: 'bots.profile.outcome_success', tone: 'success' },
  error: { key: 'bots.profile.outcome_error', tone: 'danger' },
  denied: { key: 'botsVault.outcome_denied', tone: 'neutral' },
  filled: { key: 'botsVault.outcome_filled', tone: 'success' },
  origin_mismatch: { key: 'botsVault.outcome_origin_mismatch', tone: 'danger' },
  failed: { key: 'bots.tasks.failed', tone: 'danger' },
  queued: { key: 'bots.tasks.queued', tone: 'info' },
  running: { key: 'bots.tasks.running', tone: 'info' },
  waiting: { key: 'bots.tasks.waiting', tone: 'warning' },
  succeeded: { key: 'bots.tasks.succeeded', tone: 'success' },
  canceled: { key: 'bots.tasks.canceled', tone: 'neutral' },
  interrupted: { key: 'bots.tasks.interrupted', tone: 'warning' },
};

const VAULT_ACTION: Record<string, TranslationKey> = {
  fill_login: 'botsVault.action_fill_login',
  fill_totp: 'botsVault.action_fill_totp',
  secure_login: 'botsVault.action_secure_login',
};

export function BotActivityPanel({
  botId,
  name,
  onOpenConversation,
}: {
  botId: string;
  name: string;
  /** Leaving the drawer for a conversation (`#/bots?c=`) — the host closes the drawer. */
  onOpenConversation?: () => void;
}) {
  const t = useT();
  const activity = useBotResource<BotActivityItem[]>(botId, loadActivity);

  return (
    <PanelSection title={t('bots.profile.activityTitle')} hint={t('bots.profile.activityHint', { name })}>
      {activity.state === 'loading' ? (
        <Spinner className="h-4 w-4 text-fg-faint" />
      ) : activity.state === 'failed' ? (
        <p className="text-xs text-danger">{t('bots.profile.activityFailed')}</p>
      ) : activity.data.length === 0 ? (
        <p className="text-xs text-fg-faint">{t('bots.profile.activityEmpty')}</p>
      ) : (
        <ul className="divide-y divide-edge" data-testid="bots-profile-activity">
          {[...activity.data]
            .sort((a, b) => b.at.localeCompare(a.at))
            .map((item, index) => (
              <ActivityRow key={`${item.at}-${index}`} item={item} onOpenConversation={onOpenConversation} />
            ))}
        </ul>
      )}
    </PanelSection>
  );
}

function ActivityRow({ item, onOpenConversation }: { item: BotActivityItem; onOpenConversation?: () => void }) {
  const t = useT();
  const Icon = KIND_ICON[item.kind] ?? Wrench;
  const outcome = Object.prototype.hasOwnProperty.call(OUTCOME, item.outcome) ? OUTCOME[item.outcome] : undefined;
  const vaultAction = item.kind === 'vault' && Object.prototype.hasOwnProperty.call(VAULT_ACTION, item.title);
  const title = vaultAction ? t(VAULT_ACTION[item.title]!) : item.title;
  const kind = t(KIND_LABEL[item.kind] ?? 'bots.profile.activityKind_action');
  return (
    <li className="flex items-start gap-2 py-2" data-testid="bots-profile-activity-row" data-kind={item.kind}>
      <span className="mt-0.5 flex-shrink-0 text-fg-muted" title={kind}>
        <Icon size={14} aria-label={kind} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span
            className={`min-w-0 truncate text-xs text-fg ${item.kind === 'action' ? 'font-mono' : 'font-medium'}`}
            title={title}
          >
            {title}
          </span>
          {outcome ? <Tag tone={outcome.tone}>{t(outcome.key)}</Tag> : item.outcome && <Tag>{item.outcome}</Tag>}
        </div>
        {item.detail && (
          <p className="truncate text-[11px] text-fg-muted" title={item.detail}>
            {item.detail}
          </p>
        )}
        <div className="mt-0.5 flex items-center gap-2 text-[10px] text-fg-faint">
          <span>{formatDate(item.at)}</span>
          {item.session_id && (
            <a
              href={botsConversationHash(item.session_id)}
              onClick={onOpenConversation}
              className="inline-flex items-center gap-0.5 text-primary-fg hover:underline"
              data-testid="bots-profile-activity-open"
            >
              {t('bots.profile.activityOpen')}
              <ArrowUpRight size={10} aria-hidden="true" />
            </a>
          )}
        </div>
      </div>
    </li>
  );
}
