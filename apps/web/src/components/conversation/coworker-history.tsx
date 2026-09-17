import React from 'react';
import { MessageSquare, Plus, Info, ArrowDown, Loader2, CircleAlert } from '../../lib/icons';
import { Button, IconButton } from '../ui';
import { useT } from '../../lib/i18n';
import { formatDay } from '../../lib/utils';
import { coworkerLocation, type useCoworkerInbox } from './use-coworker-inbox';

export function CoworkerHistory({
  state,
  profileId,
  sessionId,
}: {
  state: ReturnType<typeof useCoworkerInbox>;
  profileId: string;
  sessionId: string | null;
}) {
  const t = useT();
  const history = state.history;
  const others = history?.topics.filter((topic) => topic.id !== sessionId) ?? [];
  const unread = state.inbox?.first_unread_session_id
    ? { id: state.inbox.first_unread_session_id, first_unread_id: state.inbox.first_unread_message_id }
    : null;
  return (
    <section data-testid="coworker-history" className="space-y-2">
      <div className="flex items-center gap-2">
        <MessageSquare size={14} className="text-fg-muted" />
        <span className="text-xs font-medium text-fg-secondary">{t('coworker.history')}</span>
        <IconButton size="compact" label={t('coworker.topicHint')} tooltipMode="portal">
          <Info size={12} />
        </IconButton>
        <span className="flex-1" />
        {unread && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              const target = document.getElementById(`coworker-message-${unread.first_unread_id}`);
              if (sessionId === unread.id && target) target.scrollIntoView({ block: 'start', behavior: 'smooth' });
              else window.location.hash = coworkerLocation(profileId, unread.id, unread.first_unread_id!);
            }}
          >
            <ArrowDown size={12} />
            {t('coworker.firstUnread')}
          </Button>
        )}
        {!sessionId && (
          <Button size="sm" variant="ghost" onClick={() => void state.newTopic()}>
            <Plus size={14} />
            {t('coworker.newTopic')}
          </Button>
        )}
      </div>
      {state.error && (
        <button className="text-xs text-danger" onClick={() => void state.refresh()}>
          {t('coworker.loadFailed')}
        </button>
      )}
      {history?.activities.map((activity) => (
        <button
          key={activity.id}
          data-testid="coworker-activity"
          className="flex w-full items-center gap-2 rounded-lg bg-surface-muted px-3 py-2 text-left text-xs"
          onClick={() => {
            window.location.hash = coworkerLocation(profileId, activity.session_id);
          }}
        >
          {activity.attention ? (
            <CircleAlert size={13} className="text-warning" />
          ) : (
            <Loader2
              size={13}
              className={`${activity.status === 'paused' ? '' : 'motion-safe:animate-spin'} text-primary-600`}
            />
          )}
          <span className="min-w-0 flex-1 truncate">{activity.title || t('coworker.untitledTopic')}</span>
          <span className="shrink-0 text-fg-muted">
            {t(
              activity.attention
                ? 'coworker.attention'
                : activity.status === 'paused'
                  ? 'coworker.paused'
                  : 'coworker.working',
            )}
          </span>
        </button>
      ))}
      {others.map((topic) => (
        <button
          key={topic.id}
          data-testid="coworker-topic"
          data-topic-id={topic.id}
          onClick={() => {
            window.location.hash = coworkerLocation(profileId, topic.id, topic.first_unread_id ?? undefined);
          }}
          className="flex w-full items-center gap-3 rounded-lg border border-edge px-3 py-2.5 text-left transition-colors hover:bg-surface-muted"
        >
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs font-medium">{topic.title || t('coworker.untitledTopic')}</span>
            {topic.preview && <span className="mt-0.5 block truncate text-xs text-fg-muted">{topic.preview}</span>}
          </span>
          {topic.attention_count > 0 ? (
            <CircleAlert size={13} className="shrink-0 text-warning" />
          ) : topic.running_count > 0 ? (
            <Loader2 size={13} className="shrink-0 motion-safe:animate-spin text-primary-600" />
          ) : null}
          {topic.unread_count > 0 && (
            <span className="rounded-full bg-primary-600 px-1.5 text-[10px] text-white">{topic.unread_count}</span>
          )}
          <time className="shrink-0 text-[10px] text-fg-faint">{formatDay(topic.updated_at)}</time>
        </button>
      ))}
      {history?.next_cursor && (
        <Button size="sm" variant="ghost" disabled={state.loading} onClick={() => void state.loadMore()}>
          {t('coworker.olderTopics')}
        </Button>
      )}
      {!sessionId && !others.length && !state.error && (
        <p className="py-2 text-xs text-fg-muted">{t('coworker.historyEmpty')}</p>
      )}
    </section>
  );
}
