/**
 * "This is used by apps" (spec 20261011-tables-apps §5 / D6): archiving a
 * table or a field, removing select options, or deleting an automation that a
 * draft or published app references answers 409 `used_by_apps` with where
 * each app uses it. The Tables flows run those writes through
 * `useAppReferencesGuard().guard(attempt, copy)`: the first attempt goes
 * without `confirm`; that 409 opens `AppReferencesDialog` (the references,
 * each app linking to its builder, and a destructive "… anyway" that resends
 * the same write with `confirm: true`); every other failure throws to the
 * flow as before. Going ahead makes the published versions show those cards
 * and actions as unavailable.
 */

import { useCallback, useEffect, useState } from 'react';
import type { AppReferencesConflict } from '@greenhouse/types/apps';
import { TablesRequestError } from '../../lib/api/tables';
import { appBuilderHref } from '../../lib/app-routes';
import { useT } from '../../lib/i18n';
import { AppWindow } from '../../lib/icons';
import { FormActions, FormError } from '../form';
import { Button, Dialog } from '../ui';

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

/** A write refused because apps use what it removes, waiting for the person to decide. */
export interface AppReferencesRequest {
  conflict: AppReferencesConflict;
  /** Names what is being changed ("Apps use “Amount”"). */
  title: string;
  /** The destructive button ("Archive anyway"). */
  confirmLabel: string;
  /** The same write with `confirm: true`; resolves when done, throws to keep the dialog open with the error. */
  proceed: () => Promise<void>;
}

/**
 * The D6 gate for one Tables flow. `guard(attempt, copy)` runs
 * `attempt(false)`; a 409 `used_by_apps` resolves `'asked'` and opens the
 * references (render `<AppReferencesDialog request={request} onClose={close} />`),
 * whose button runs `attempt(true)`. Success resolves `'done'`; any other
 * failure throws unchanged.
 */
export function useAppReferencesGuard() {
  const [request, setRequest] = useState<AppReferencesRequest | null>(null);
  const guard = useCallback(
    async (
      attempt: (confirm: boolean) => Promise<void>,
      copy: { title: string; confirmLabel: string },
    ): Promise<'done' | 'asked'> => {
      try {
        await attempt(false);
        return 'done';
      } catch (error) {
        const conflict = appReferencesOf(error);
        if (!conflict) throw error;
        setRequest({ conflict, ...copy, proceed: () => attempt(true) });
        return 'asked';
      }
    },
    [],
  );
  const close = useCallback(() => setRequest(null), []);
  return { request, guard, close };
}

export function AppReferencesDialog({
  request,
  onClose,
}: {
  request: AppReferencesRequest | null;
  onClose: () => void;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Retained so the body doesn't blank out while the dialog animates closed.
  const [shown, setShown] = useState<AppReferencesRequest | null>(request);
  useEffect(() => {
    if (request) setShown(request);
    setError('');
  }, [request]);

  const proceed = async () => {
    if (!request || busy) return;
    setBusy(true);
    setError('');
    try {
      await request.proceed();
      onClose();
    } catch (proceedError) {
      setError(
        proceedError instanceof Error && proceedError.message
          ? proceedError.message
          : t('apps.builder.references.failed'),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={request !== null}
      onClose={() => {
        if (!busy) onClose();
      }}
      title={shown?.title ?? ''}
      size="md"
    >
      {shown && (
        <div className="space-y-4" data-testid="app-references-dialog">
          <AppReferencesList conflict={shown.conflict} />
          <FormError>{error}</FormError>
          <FormActions className="border-t border-edge pt-4">
            <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => void proceed()}
              data-testid="app-references-proceed"
            >
              {shown.confirmLabel}
            </Button>
          </FormActions>
        </div>
      )}
    </Dialog>
  );
}
