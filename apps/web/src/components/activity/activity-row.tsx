/**
 * One change in the Activity log and the Home "recent changes" feed: who, via
 * which agent if any, what, to what, when — linking to the object or, for an
 * agent write or an automation, to the run's detail page.
 *
 * Copy is composed from translated pieces (verb + entity/module), so the server
 * only sends stable ids; the raw action id is the last-resort fallback.
 */

import type { ActivityItem } from '@greenhouse/types/activity';
import { Avatar, Tag } from '../ui';
import { Bot, ShieldCheck, Zap } from '../../lib/icons';
import { useT, type TranslationKey } from '../../lib/i18n';
import { formatDate, timeAgo } from '../../lib/utils';
import { executionRunHref } from '../../lib/execution-route';

type Translate = ReturnType<typeof useT>;

function has(t: Translate, key: string): string | null {
  const value = t(key as TranslationKey);
  return value === key ? null : value;
}

export function activityModuleLabel(t: Translate, module: string): string {
  return has(t, `activity.module.${module}`) ?? module;
}

/**
 * "updated project", "deleted file", "ran automation" — the middle of the
 * sentence, the same for one change wherever it shows (Activity log, Home).
 * An action with a phrase of its own ("connected agent") uses it; otherwise
 * verb + kind of object, the module only when the object is unknown.
 */
export function activityPhrase(t: Translate, item: ActivityItem): string {
  const own = /^[A-Za-z]+$/.test(item.action) ? has(t, `activity.action.${item.action}`) : null;
  if (own) return own;
  const verb = has(t, `activity.verb.${item.verb}`);
  const entity = item.entity ? has(t, `activity.entity.${item.entity}`) : null;
  if (verb && item.verb !== 'other')
    return t('activity.phrase', { verb, what: entity ?? activityModuleLabel(t, item.module) });
  return item.action_title ?? item.action;
}

const STATUS_TONE = {
  succeeded: 'success',
  failed: 'danger',
  outcome_unknown: 'warning',
  canceled: 'neutral',
  running: 'info',
} as const;

export function activityHref(item: ActivityItem): string | null {
  if (item.run) return executionRunHref({ kind: item.run.kind as never, id: item.run.id });
  return item.target?.url ?? null;
}

export function ActivityRow({ item, compact = false }: { item: ActivityItem; compact?: boolean }) {
  const t = useT();
  const href = activityHref(item);
  const actor = item.actor.name ?? t('activity.unknownPerson');
  const target = item.target?.label ?? (item.target?.id ? `#${item.target.id}` : null);
  const icon =
    item.source === 'agent'
      ? Bot
      : item.source === 'automation'
        ? Zap
        : item.source === 'admin'
          ? ShieldCheck
          : undefined;

  const body = (
    <>
      <Avatar name={actor} icon={icon} size="sm" variant={item.source === 'person' ? 'default' : 'primary'} />
      <div className="min-w-0 flex-1">
        <p
          className="truncate text-sm text-fg"
          title={[actor, activityPhrase(t, item), target].filter(Boolean).join(' ')}
        >
          <span className="font-medium">{actor}</span>{' '}
          <span className="text-fg-secondary">{activityPhrase(t, item)}</span>
          {target && <span className="font-medium"> {target}</span>}
        </p>
        <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-1.5 text-[11px] text-fg-faint">
          <span title={formatDate(item.at)}>{timeAgo(item.at)}</span>
          <Tag size="xs">{activityModuleLabel(t, item.module)}</Tag>
          {item.agent && (
            <Tag size="xs" tone="primary" icon={<Bot size={10} aria-hidden="true" />}>
              {t('activity.viaAgent', { client: item.agent.client_name })}
            </Tag>
          )}
          {!compact && item.source === 'admin' && (
            <Tag size="xs" tone="warning">
              {t('activity.source.admin')}
            </Tag>
          )}
          {item.status && item.status !== 'succeeded' && (
            <Tag size="xs" tone={STATUS_TONE[item.status]}>
              {t(`activity.status.${item.status}` as TranslationKey)}
            </Tag>
          )}
          {!compact && item.detail && (
            <span className="min-w-0 truncate" title={item.detail}>
              {item.detail}
            </span>
          )}
        </div>
      </div>
    </>
  );

  const className = 'flex min-w-0 items-start gap-3 px-3 py-2.5';
  return href ? (
    <a href={href} className={`${className} transition-colors hover:bg-surface-muted`} data-activity-id={item.id}>
      {body}
    </a>
  ) : (
    <div className={className} data-activity-id={item.id}>
      {body}
    </div>
  );
}
