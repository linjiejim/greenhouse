/**
 * Home (团队动态) — what changed across the team lately, plus the member's own
 * workbench cards.
 *
 * The feed reads `GET /api/activity/recent`, which only returns objects the
 * viewer may read and says which agent made a change when one did. The cards
 * are the personal workbench (one stored config, including recipes extensions
 * register); this is their only home since v1.5, and Customize lives in the
 * page actions.
 */

import { useCallback, useEffect, useState } from 'react';
import type { ActivityItem } from '@greenhouse/types/activity';
import { ModulePage } from '../components/app/module-page';
import { ActivityRow } from '../components/activity/activity-row';
import { SettingsSection } from '../components/settings';
import { Button, EmptyState, SkeletonRow } from '../components/ui';
import { WorkbenchPanel } from '../components/workbench/workbench-panel';
import { WorkbenchTopBarActions } from '../components/workbench/workbench-topbar-actions';
import { History, RefreshCw } from '../lib/icons';
import { useT } from '../lib/i18n';
import { fetchRecentChanges } from '../lib/api/activity';
import { ACTIVITY_ROOT_HASH } from '../lib/execution-route';
import { useUIStore } from '../stores';

const FEED_SIZE = 12;

export function HomePage() {
  const t = useT();
  const homeWorkbench = useUIStore((state) => state.homeWorkbench);
  const [items, setItems] = useState<ActivityItem[] | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setItems(await fetchRecentChanges(FEED_SIZE));
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('home.feedFailed'));
      setItems((current) => current ?? []);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <ModulePage
      moduleId="workspace.home"
      layout="list"
      actions={<WorkbenchTopBarActions controls={homeWorkbench} />}
      contentClassName="space-y-4"
    >
      <SettingsSection
        title={t('home.recentChanges')}
        description={t('home.recentChangesHint')}
        icon={History}
        action={
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" onClick={() => void load()} aria-label={t('common.refresh')}>
              <RefreshCw size={13} aria-hidden="true" />
            </Button>
            <a href={ACTIVITY_ROOT_HASH} className="text-xs text-fg-muted hover:text-fg">
              {t('home.viewAllActivity')}
            </a>
          </div>
        }
      >
        {items === null ? (
          <div className="space-y-2">
            <SkeletonRow />
            <SkeletonRow />
            <SkeletonRow />
          </div>
        ) : error && items.length === 0 ? (
          <EmptyState icon={History} variant="compact" tone="danger" title={t('home.feedFailed')} description={error} />
        ) : items.length === 0 ? (
          <EmptyState
            icon={History}
            variant="compact"
            tone="neutral"
            title={t('home.feedEmpty')}
            description={t('home.feedEmptyHint')}
          />
        ) : (
          <div className="-mx-1 divide-y divide-edge" role="list" data-testid="home-recent-changes">
            {items.map((item) => (
              <div role="listitem" key={item.id}>
                <ActivityRow item={item} compact />
              </div>
            ))}
          </div>
        )}
      </SettingsSection>

      {/* The personal workbench; with no cards it stays out of the way until Customize. */}
      <WorkbenchPanel />
    </ModulePage>
  );
}
