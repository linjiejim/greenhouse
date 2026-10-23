/**
 * SkillHub — top-level page for the org-wide agent skill library, plus the
 * user's prompt (Task) library as a second tab.
 *
 * Skills tab, master-detail: the grouped, searchable skill list lives in the
 * global sidebar rail (SkillHubNavPanel); this page renders the right pane.
 * Selection is URL-driven — `#/skillhub/<name>` shows that skill's detail, bare
 * `#/skillhub` shows the onboarding landing.
 *
 * Mobile has no rail, so the page itself carries the list: no selection → the
 * full-width grouped list; a selection → the detail with a back link. Both reuse
 * the same shared components (components/skillhub) — one implementation.
 *
 * My prompts tab: `#/skillhub?tab=prompts` (the retired `#/tasks` page redirects
 * here). Report templates tab: `#/skillhub?tab=reports` (v1.7). Tabs live in
 * the query, not the path, because the path segment is a skill name.
 */

import React, { useState } from 'react';
import { SkillDetail, SkillHubLanding, SkillHubList, SkillUploadDialog } from '../../components/skillhub';
import { ModulePage } from '../../components/app/module-page';
import { Button, Tabs } from '../../components/ui';
import { Upload } from '../../lib/icons';
import { useT } from '../../lib/i18n';
import { SKILLHUB_PROMPTS_HASH, SKILLHUB_REPORTS_HASH } from '../../lib/workspace-routes';
import { PromptsPanel } from './prompts';
import { ReportTemplatesPanel } from './report-templates';

type SkillHubTab = 'skills' | 'prompts' | 'reports';

const TAB_HASH: Record<SkillHubTab, string> = {
  skills: '#/skillhub',
  prompts: SKILLHUB_PROMPTS_HASH,
  reports: SKILLHUB_REPORTS_HASH,
};

export function SkillHubPage({ subPath, params }: { subPath: string; params?: URLSearchParams }) {
  const t = useT();
  const name = subPath.split('/').filter(Boolean)[0] || '';
  const [uploadOpen, setUploadOpen] = useState(false);
  const requested = params?.get('tab');
  const tab: SkillHubTab = requested === 'prompts' || requested === 'reports' ? requested : 'skills';

  if (name) {
    return (
      <div className="h-full overflow-hidden bg-surface-canvas">
        <SkillDetail name={name} backHref="#/skillhub" />
      </div>
    );
  }

  const tabs = (
    <Tabs
      tabs={[
        { key: 'skills', label: t('skillHub.tabs.skills') },
        { key: 'prompts', label: t('skillHub.tabs.prompts') },
        { key: 'reports', label: t('skillHub.tabs.reports') },
      ]}
      active={tab}
      onChange={(key) => {
        window.location.hash = TAB_HASH[key as SkillHubTab] ?? '#/skillhub';
      }}
      ariaLabel={t('skillHub.tabs.label')}
    />
  );

  if (tab === 'prompts') {
    return (
      <ModulePage moduleId="workspace.skillhub" layout="list" tabs={tabs}>
        <PromptsPanel />
      </ModulePage>
    );
  }

  if (tab === 'reports') {
    return (
      <ModulePage
        moduleId="workspace.skillhub"
        layout="list"
        tabs={tabs}
        notice={<p className="text-xs text-fg-muted">{t('reportTemplates.notice')}</p>}
      >
        <ReportTemplatesPanel />
      </ModulePage>
    );
  }

  return (
    <ModulePage
      moduleId="workspace.skillhub"
      layout="canvas"
      tabs={tabs}
      actions={
        <Button size="sm" onClick={() => setUploadOpen(true)}>
          <Upload size={14} />
          {t('skillHub.upload')}
        </Button>
      }
    >
      {/* Desktop: onboarding landing (the grouped list lives in the rail). */}
      <div className="hidden h-full overflow-y-auto md:block">
        <SkillHubLanding showHeader={false} />
      </div>
      {/* Mobile: the full-width grouped list stands in for the hidden rail. */}
      <div className="flex h-full flex-col md:hidden">
        <SkillHubList />
      </div>
      <SkillUploadDialog
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        onPublished={(published) => {
          window.location.hash = `#/skillhub/${published}`;
        }}
      />
    </ModulePage>
  );
}
