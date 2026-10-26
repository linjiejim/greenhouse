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

import React, { useState, type ReactNode } from 'react';
import { SkillDetail, SkillHubLanding, SkillHubList, SkillUploadDialog } from './components/skillhub/index.js';
import { ModulePage } from '@greenhouse/web/extension-kit';
import { Button } from '@greenhouse/web/extension-kit';
import { Upload } from '@greenhouse/web/extension-kit';
import { useT } from '@greenhouse/web/extension-kit';

export function SkillHubPage({ subPath, tabs }: { subPath: string; params?: URLSearchParams; tabs?: ReactNode }) {
  const t = useT();
  const name = subPath.split('/').filter(Boolean)[0] || '';
  const [uploadOpen, setUploadOpen] = useState(false);
  if (name) {
    return (
      <div className="h-full overflow-hidden bg-surface-canvas">
        <SkillDetail name={name} backHref="#/skillhub" />
      </div>
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
          {t('ext.skills.skillHub.upload')}
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
