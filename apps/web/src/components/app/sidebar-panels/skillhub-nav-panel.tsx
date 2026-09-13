/**
 * SkillHub nav panel — sidebar contextual panel for the SkillHub tab.
 *
 * Thin wrapper: a header + the shared grouped, searchable SkillHubList (reused
 * by the mobile SkillHub page). Selection is URL-driven (`#/skillhub/<name>`);
 * `activeName` comes from the route subPath so the current skill highlights.
 *
 * The header carries the Upload entry point and, for supers, a count of skills
 * awaiting a security ruling — derived from the catalog the list already loads,
 * so it costs no extra request.
 */

import React, { useState } from 'react';
import { IconButton } from '../../ui';
import { Upload } from '../../../lib/icons';
import { useAuthStore } from '../../../stores';
import { SkillHubList, SkillUploadDialog, countNeedsReview, useSkills } from '../../skillhub';
import { useT } from '../../../lib/i18n';

export function SkillHubNavPanel({ activeName }: { activeName?: string }) {
  const t = useT();
  const { currentUser } = useAuthStore();
  const { skills } = useSkills();
  const [uploadOpen, setUploadOpen] = useState(false);
  const reviewCount = currentUser?.role === 'super' ? countNeedsReview(skills) : 0;

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="px-3 py-2 flex-shrink-0 flex items-center gap-2">
        <span className="text-xs font-medium text-fg-muted uppercase tracking-wide">SkillHub</span>
        {reviewCount > 0 && (
          <span
            className="rounded-full bg-warning-subtle px-1.5 text-[10px] font-medium text-warning"
            title={t('skillHub.awaitingReview', { count: reviewCount })}
          >
            {reviewCount}
          </span>
        )}
        <div className="flex-1" />
        <IconButton label={t('skillHub.upload')} onClick={() => setUploadOpen(true)}>
          <Upload size={14} />
        </IconButton>
      </div>
      <SkillHubList selectedName={activeName} />
      <SkillUploadDialog
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        onPublished={(name) => {
          window.location.hash = `#/skillhub/${name}`;
        }}
      />
    </div>
  );
}
