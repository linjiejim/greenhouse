/**
 * What only an app's managers see above its pages:
 * - the preview bar — they open an app with full access; "preview as" shows
 *   it exactly as one role gets it (pages, cards, rows, columns, actions —
 *   the gateway evaluates for that role; writes still run as the manager).
 *   On the draft (`?draft=1`, the builder's "Preview") it says so: what is on
 *   screen is not live yet, switching roles stays on the draft, and leaving
 *   goes back to the builder;
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
  draft = false,
  onChange,
  onExit,
}: {
  roles: ReadonlyArray<{ key: string; name: string }>;
  previewRole: string | undefined;
  /** The previewed role's name (from the trimmed view). */
  previewName?: string;
  /** The draft is on screen, not the published version. */
  draft?: boolean;
  /** Another role, or full access (`undefined`) — on the same version. */
  onChange: (roleKey: string | undefined) => void;
  /** Leave the preview (back to full access; from the draft, back to the builder). */
  onExit: () => void;
}) {
  const t = useT();
  const role = previewName ?? previewRole;
  if (!draft && !role && roles.length === 0) return null;
  return (
    <div
      className={`flex flex-col gap-2 rounded-md border px-3 py-2 text-xs sm:flex-row sm:items-center ${draft || role ? 'border-info bg-info-subtle text-info' : 'border-edge text-fg-muted'}`}
      role="status"
      data-testid="app-preview-bar"
      data-draft={draft ? 'true' : undefined}
    >
      <div className="flex min-w-0 flex-1 items-start gap-2 sm:items-center">
        <Eye size={14} aria-hidden="true" className="mt-px flex-shrink-0 sm:mt-0" />
        <span className="min-w-0">
          {draft
            ? role
              ? t('apps.runtime.preview.draftAs', { role })
              : t('apps.runtime.preview.draftFullAccess')
            : role
              ? t('apps.runtime.preview.previewing', { role })
              : t('apps.runtime.preview.fullAccess')}
        </span>
      </div>
      <div className="flex flex-shrink-0 flex-wrap items-center gap-2">
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
        {(previewRole || draft) && (
          <Button
            variant="ghost"
            size="sm"
            className="min-h-11 md:min-h-0"
            onClick={onExit}
            data-testid="app-preview-exit"
          >
            {draft ? t('apps.runtime.preview.backToBuilder') : t('apps.runtime.preview.exit')}
          </Button>
        )}
      </div>
    </div>
  );
}

const SHOWN_ISSUES = 3;

export function IssuesBar({
  issues,
  pages,
  version,
  draft = false,
  builderHref,
}: {
  issues: readonly AppIssue[];
  pages: readonly AppPage[];
  version: number;
  /** The draft is on screen: its problems, not a published version's. */
  draft?: boolean;
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
          {draft
            ? t('apps.runtime.issues.draftTitle', { count: issues.length })
            : t('apps.runtime.issues.title', { version, count: issues.length })}
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
