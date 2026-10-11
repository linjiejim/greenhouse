/**
 * What only an app's managers see above its pages:
 * - the preview bar — they open an app with full access; "preview as" shows
 *   it exactly as one role gets it (pages, cards, rows, columns, actions —
 *   the gateway evaluates for that role; writes still run as the manager);
 * - the issues bar — the runtime revalidation found cards or actions that
 *   refer to something deleted or changed since this version (D6); viewers
 *   see those cards as unavailable, managers see why and where to fix it.
 */

import type { AppIssue, AppPage } from '@greenhouse/types/apps';
import { Button, Select } from '../../../components/ui';
import { useT } from '../../../lib/i18n';
import { AlertTriangle, Eye } from '../../../lib/icons';

export function PreviewBar({
  roles,
  previewRole,
  previewName,
  onChange,
}: {
  roles: ReadonlyArray<{ key: string; name: string }>;
  previewRole: string | undefined;
  /** The previewed role's name (from the trimmed view). */
  previewName?: string;
  onChange: (roleKey: string | undefined) => void;
}) {
  const t = useT();
  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-info bg-info-subtle px-3 py-2 text-xs text-info"
      role="status"
      data-testid="app-preview-bar"
    >
      <Eye size={14} aria-hidden="true" className="flex-shrink-0" />
      <span className="min-w-0 flex-1">
        {previewRole
          ? t('apps.runtime.preview.previewing', { role: previewName ?? previewRole })
          : t('apps.runtime.preview.fullAccess')}
      </span>
      {roles.length > 0 && (
        <Select
          size="sm"
          inline
          aria-label={t('apps.runtime.preview.switchLabel')}
          value={previewRole ?? ''}
          onChange={(event) => onChange(event.target.value || undefined)}
          data-testid="app-preview-role"
        >
          <option value="">{t('apps.runtime.managerView')}</option>
          {roles.map((role) => (
            <option key={role.key} value={role.key}>
              {t('apps.runtime.preview.asRole', { role: role.name })}
            </option>
          ))}
        </Select>
      )}
      {previewRole && (
        <Button variant="ghost" size="sm" className="min-h-11 md:min-h-0" onClick={() => onChange(undefined)}>
          {t('apps.runtime.preview.exit')}
        </Button>
      )}
    </div>
  );
}

const SHOWN_ISSUES = 3;

export function IssuesBar({
  issues,
  pages,
  version,
  builderHref,
}: {
  issues: readonly AppIssue[];
  pages: readonly AppPage[];
  version: number;
  builderHref: string;
}) {
  const t = useT();
  if (issues.length === 0) return null;
  const where = (issue: AppIssue) => {
    const page = pages.find((entry) => entry.id === issue.pageId);
    const card = page?.cards.find((entry) => entry.id === issue.cardId);
    return [page?.title ?? issue.pageId, card ? card.title || card.id : null].filter(Boolean).join(' · ');
  };
  return (
    <div
      className="space-y-1.5 rounded-md border border-warning bg-warning-subtle px-3 py-2 text-xs text-warning"
      role="status"
      data-testid="app-issues-bar"
    >
      <div className="flex flex-wrap items-center gap-2">
        <AlertTriangle size={14} aria-hidden="true" className="flex-shrink-0" />
        <span className="min-w-0 flex-1 font-medium">
          {t('apps.runtime.issues.title', { version, count: issues.length })}
        </span>
        <a href={builderHref} className="inline-flex min-h-11 items-center font-medium underline md:min-h-0">
          {t('apps.runtime.issues.fix')}
        </a>
      </div>
      <ul className="space-y-0.5 pl-6">
        {issues.slice(0, SHOWN_ISSUES).map((issue, index) => (
          <li key={`${issue.pageId}:${issue.cardId ?? ''}:${issue.actionId ?? ''}:${issue.filterId ?? ''}:${index}`}>
            <span className="font-medium">{where(issue)}</span> — {issue.message}
          </li>
        ))}
        {issues.length > SHOWN_ISSUES && (
          <li>{t('apps.runtime.issues.more', { count: issues.length - SHOWN_ISSUES })}</li>
        )}
      </ul>
    </div>
  );
}
