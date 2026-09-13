/**
 * SkillHub — top-level page for the org-wide agent skill library.
 *
 * Master-detail: the grouped, searchable skill list lives in the global sidebar
 * rail (SkillHubNavPanel); this page renders the right pane. Selection is
 * URL-driven — `#/skillhub/<name>` shows that skill's detail, bare `#/skillhub`
 * shows the onboarding landing.
 *
 * Mobile has no rail, so the page itself carries the list: no selection → the
 * full-width grouped list; a selection → the detail with a back link. Both reuse
 * the same shared components (components/skillhub) — one implementation.
 */

import React, { useState } from 'react';
import { SkillDetail, SkillHubLanding, SkillHubList, SkillUploadDialog } from '../../components/skillhub';
import { ModulePage } from '../../components/app/module-page';
import { Button } from '../../components/ui';
import { Upload } from '../../lib/icons';
import { useT } from '../../lib/i18n';

export function SkillHubPage({ subPath }: { subPath: string }) {
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
      actions={
        <Button size="sm" onClick={() => setUploadOpen(true)}>
          <Upload size={14} className="mr-1" />
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
