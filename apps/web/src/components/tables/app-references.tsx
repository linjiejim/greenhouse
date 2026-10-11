/**
 * "This is used by apps" (spec 20261011-tables-apps §5 / D6): archiving a
 * field, removing a select option, deleting an automation or a role that a
 * draft or published app references answers 409 `used_by_apps` with where
 * each app uses it. A Tables dialog reads that with `appReferencesOf`, lists
 * the references with `AppReferencesList` (each app links to its builder),
 * and lets the builder go ahead by resending with `confirm: true` — the
 * published versions then show those cards and actions as unavailable.
 */

import type { AppReferencesConflict } from '@greenhouse/types/apps';
import { TablesRequestError } from '../../lib/api/tables';
import { appBuilderHref } from '../../lib/app-routes';
import { useT } from '../../lib/i18n';
import { AppWindow } from '../../lib/icons';

/** The 409 `used_by_apps` details, or null for any other failure. */
export function appReferencesOf(error: unknown): AppReferencesConflict | null {
  if (!(error instanceof TablesRequestError) || error.status !== 409) return null;
  const details = error.details;
  if (details?.reason !== 'used_by_apps' || !Array.isArray(details.references)) return null;
  const references = details.references.flatMap((entry: unknown) => {
    const reference = entry as Partial<AppReferencesConflict['references'][number]> | null;
    return reference && typeof reference.appId === 'number' && typeof reference.name === 'string'
      ? [
          {
            appId: reference.appId,
            name: reference.name,
            where: typeof reference.where === 'string' ? reference.where : '',
          },
        ]
      : [];
  });
  return { reason: 'used_by_apps', references };
}

export function AppReferencesList({ conflict }: { conflict: AppReferencesConflict }) {
  const t = useT();
  return (
    <div
      className="space-y-2 rounded-md border border-warning bg-warning-subtle px-3 py-2"
      data-testid="app-references"
    >
      <p className="text-xs font-medium text-warning">{t('apps.builder.references.title')}</p>
      <ul className="space-y-1 text-xs text-fg-secondary">
        {conflict.references.map((reference, index) => (
          <li key={`${reference.appId}-${index}`} className="flex items-start gap-1.5">
            <AppWindow size={12} className="mt-0.5 flex-shrink-0 text-fg-muted" />
            <span className="min-w-0">
              <a href={appBuilderHref(reference.appId)} className="font-medium text-primary-fg hover:underline">
                {reference.name}
              </a>
              {reference.where && <span className="text-fg-muted"> · {reference.where}</span>}
            </span>
          </li>
        ))}
      </ul>
      <p className="text-[11px] leading-4 text-fg-muted">{t('apps.builder.references.consequence')}</p>
    </div>
  );
}
