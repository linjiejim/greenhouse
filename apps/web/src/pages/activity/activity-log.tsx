/**
 * Activity log (操作记录) — changes by people, members' agents, automations and
 * administrators, newest first.
 *
 * Members see their own record; a super sees everyone's and may narrow to one
 * person (the API enforces both). Filters: source, module, person, date range;
 * paging is cursor-based ("Load more"), and the CSV export applies the same
 * filters server-side. Rows open the object, or the run detail for an agent
 * write or an automation (`#/activity/<kind>/<id>`).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ACTIVITY_MODULES, ACTIVITY_SOURCES, type ActivityItem, type ActivitySource } from '@greenhouse/types/activity';
import { ModulePage } from '../../components/app/module-page';
import { ActivityRow, activityModuleLabel } from '../../components/activity/activity-row';
import { Button, DateRangeInput, EmptyState, Select, SkeletonCard, toast } from '../../components/ui';
import { Download, History, RefreshCw } from '../../lib/icons';
import { useT, type TranslationKey } from '../../lib/i18n';
import { exportActivityCsv, fetchActivity, type ActivityFilters } from '../../lib/api/activity';
import { fetchManagedUsers } from '../../lib/api/admin';
import { useAuthStore } from '../../stores';

/** A date input value (YYYY-MM-DD) as the start / the end of that local day, in ISO. */
function dayStart(value: string): string | null {
  return value ? new Date(`${value}T00:00:00`).toISOString() : null;
}
function dayEnd(value: string): string | null {
  return value ? new Date(new Date(`${value}T00:00:00`).getTime() + 24 * 60 * 60 * 1000).toISOString() : null;
}

export function ActivityLogPage({ moduleId }: { moduleId: 'workspace.activity' | 'admin.activity' }) {
  const t = useT();
  const currentUser = useAuthStore((state) => state.currentUser);
  const isSuper = currentUser?.role === 'super';
  const [source, setSource] = useState<ActivitySource | ''>('');
  const [module, setModule] = useState('');
  const [userId, setUserId] = useState('');
  const [range, setRange] = useState({ from: '', to: '' });
  const [people, setPeople] = useState<Array<{ id: string; nickname: string }>>([]);
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');

  const filters: ActivityFilters = useMemo(
    () => ({
      source: source || null,
      module: module || null,
      userId: isSuper ? userId || null : null,
      from: dayStart(range.from),
      to: dayEnd(range.to),
    }),
    [isSuper, module, range.from, range.to, source, userId],
  );

  useEffect(() => {
    if (!isSuper) return;
    fetchManagedUsers()
      .then((result) => setPeople(result.users.map((user) => ({ id: user.id, nickname: user.nickname }))))
      .catch(() => setPeople([]));
  }, [isSuper]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const page = await fetchActivity(filters);
      setItems(page.items);
      setCursor(page.next_cursor);
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('activity.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [filters, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadMore = async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await fetchActivity(filters, { cursor });
      setItems((current) => {
        const known = new Set(current.map((item) => item.id));
        return [...current, ...page.items.filter((item) => !known.has(item.id))];
      });
      setCursor(page.next_cursor);
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : t('activity.loadFailed'), 'error');
    } finally {
      setLoadingMore(false);
    }
  };

  const sources = ACTIVITY_SOURCES.filter((value) => isSuper || value !== 'admin');
  const modules = ACTIVITY_MODULES.filter((value) => isSuper || !['settings', 'users'].includes(value));

  return (
    <ModulePage
      moduleId={moduleId}
      layout="list"
      actions={
        <>
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw size={13} aria-hidden="true" />
            {t('common.refresh')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => exportActivityCsv(filters).catch(() => toast(t('activity.exportFailed'), 'error'))}
          >
            <Download size={13} aria-hidden="true" />
            {t('activity.exportCsv')}
          </Button>
        </>
      }
      notice={
        error ? (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-danger bg-danger-subtle px-3 py-2 text-xs text-danger">
            <span className="min-w-0 flex-1">{error}</span>
            <Button variant="outline" size="sm" onClick={() => void load()}>
              {t('common.tryAgain')}
            </Button>
          </div>
        ) : !isSuper ? (
          <p className="text-xs text-fg-muted">{t('activity.ownOnly')}</p>
        ) : undefined
      }
      toolbar={
        <div className="flex flex-wrap items-center gap-2">
          <Select
            size="sm"
            inline
            value={source}
            aria-label={t('activity.filterSource')}
            onChange={(event) => setSource(event.target.value as ActivitySource | '')}
          >
            <option value="">{t('activity.allSources')}</option>
            {sources.map((value) => (
              <option key={value} value={value}>
                {t(`activity.source.${value}` as TranslationKey)}
              </option>
            ))}
          </Select>
          <Select
            size="sm"
            inline
            value={module}
            aria-label={t('activity.filterModule')}
            onChange={(event) => setModule(event.target.value)}
          >
            <option value="">{t('activity.allModules')}</option>
            {modules.map((value) => (
              <option key={value} value={value}>
                {activityModuleLabel(t, value)}
              </option>
            ))}
          </Select>
          {isSuper && (
            <Select
              size="sm"
              inline
              value={userId}
              aria-label={t('activity.filterPerson')}
              onChange={(event) => setUserId(event.target.value)}
            >
              <option value="">{t('activity.everyone')}</option>
              {people.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.nickname}
                </option>
              ))}
            </Select>
          )}
          <DateRangeInput from={range.from} to={range.to} onChange={(from, to) => setRange({ from, to })} />
        </div>
      }
    >
      {loading && items.length === 0 ? (
        <div className="grid gap-2">
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          icon={History}
          tone="neutral"
          title={t('activity.emptyTitle')}
          description={t('activity.emptyDescription')}
        />
      ) : (
        <div className="divide-y divide-edge overflow-hidden rounded-lg border border-edge" role="list">
          {items.map((item) => (
            <div role="listitem" key={item.id}>
              <ActivityRow item={item} />
            </div>
          ))}
        </div>
      )}

      {cursor && (
        <div className="flex justify-center py-4">
          <Button variant="outline" size="sm" onClick={() => void loadMore()} disabled={loadingMore}>
            {loadingMore ? t('common.loading') : t('activity.loadMore')}
          </Button>
        </div>
      )}
    </ModulePage>
  );
}
