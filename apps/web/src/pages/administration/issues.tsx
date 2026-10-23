/**
 * Issues & requests (问题与需求) — one admin page for what members and their
 * agents report: feature requests (things to build) and frictions (where the
 * tooling got in the way). Two tabs over the two existing queues; the tab is
 * the URL (`#/administration/issues/requests|frictions`), and the retired
 * `#/administration/feature-requests` / `#/administration/frictions` links
 * redirect here (redirects.ts).
 */

import { Tabs } from '../../components/ui';
import { useT } from '../../lib/i18n';
import { FeatureRequestsPanel } from './feature-requests';
import { FrictionsPanel } from './frictions';

export type IssuesTab = 'requests' | 'frictions';

export function issuesTabOf(subPath: string): IssuesTab {
  return subPath.split('/').filter(Boolean)[1] === 'frictions' ? 'frictions' : 'requests';
}

export function IssuesPanel({ subPath }: { subPath: string }) {
  const t = useT();
  const tab = issuesTabOf(subPath);
  const tabs = (
    <Tabs
      tabs={[
        { key: 'requests', label: t('issues.tab.requests') },
        { key: 'frictions', label: t('issues.tab.frictions') },
      ]}
      active={tab}
      onChange={(key) => {
        window.location.hash = `#/administration/issues/${key}`;
      }}
      ariaLabel={t('issues.tabsLabel')}
    />
  );
  return tab === 'frictions' ? <FrictionsPanel tabs={tabs} /> : <FeatureRequestsPanel tabs={tabs} />;
}
