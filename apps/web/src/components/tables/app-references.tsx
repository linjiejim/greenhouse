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
 *
 * Each place is worded here, in the reader's language, from the structured
 * fields the server sends (`version`, `page`, `filter` / `card` / `action` /
 * `move`, `role`; an untitled card is named by its kind). A server that sends
 * only the English `where` string gets that string shown as is.
 */

import { useCallback, useEffect, useState } from 'react';
import { APP_CARD_KINDS, type AppReference, type AppReferencesConflict } from '@greenhouse/types/apps';
import { TablesRequestError } from '../../lib/api/tables';
import { appBuilderHref } from '../../lib/app-routes';
import { useT } from '../../lib/i18n';
import { AppWindow } from '../../lib/icons';
import { FormActions, FormError } from '../form';
import { Button, Dialog } from '../ui';

type Place = Omit<AppReference, 'appId' | 'name' | 'where'>;

const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** The structured place of one wire reference — each part kept only when well-formed. */
function placeOf(raw: Record<string, unknown>): Place {
  const place: Place = {};
  const { version, page, filter, card, action, role } = raw;
  if (version === 'draft' || (typeof version === 'number' && Number.isInteger(version) && version > 0)) {
    place.version = version;
  }
  if (isRecord(page) && isText(page.id) && typeof page.title === 'string')
    place.page = { id: page.id, title: page.title };
  if (isRecord(filter) && isText(filter.id) && typeof filter.label === 'string') {
    place.filter = { id: filter.id, label: filter.label };
  }
  if (isRecord(card) && isText(card.id) && (APP_CARD_KINDS as readonly unknown[]).includes(card.kind)) {
    place.card = {
      id: card.id,
      kind: card.kind as NonNullable<Place['card']>['kind'],
      ...(isText(card.title) ? { title: card.title } : {}),
    };
  }
  if (isRecord(action) && isText(action.id) && typeof action.label === 'string') {
    place.action = { id: action.id, label: action.label };
  }
  if (raw.move === true) place.move = true;
  if (isRecord(role) && isText(role.key) && typeof role.name === 'string')
    place.role = { key: role.key, name: role.name };
  return place;
}

/** The 409 `used_by_apps` details, or null for any other failure. */
export function appReferencesOf(error: unknown): AppReferencesConflict | null {
  if (!(error instanceof TablesRequestError) || error.status !== 409) return null;
  const details = error.details;
  if (details?.reason !== 'used_by_apps' || !Array.isArray(details.references)) return null;
  const references = details.references.flatMap((entry: unknown): AppReference[] => {
    if (!isRecord(entry) || typeof entry.appId !== 'number' || typeof entry.name !== 'string') return [];
    return [
      {
        appId: entry.appId,
        name: entry.name,
        where: typeof entry.where === 'string' ? entry.where : '',
        ...placeOf(entry),
      },
    ];
  });
  return { reason: 'used_by_apps', references };
}

/** One reference's place in the reader's language; the server's English words when it sent no structure. */
function usePlaceWords() {
  const t = useT();
  return (reference: AppReference): string => {
    if (reference.version === undefined) return reference.where;
    const parts = [
      reference.version === 'draft'
        ? t('apps.builder.references.place.draft')
        : t('apps.builder.references.place.version', { version: reference.version }),
    ];
    if (reference.page) parts.push(t('apps.builder.references.place.page', { title: reference.page.title }));
    if (reference.filter) parts.push(t('apps.builder.references.place.filter', { label: reference.filter.label }));
    if (reference.card) {
      parts.push(
        reference.card.title
          ? t('apps.builder.references.place.card', { title: reference.card.title })
          : t('apps.builder.references.place.untitledCard', {
              kind: t(`apps.builder.catalog.kinds.${reference.card.kind}.name`),
            }),
      );
    }
    if (reference.action) parts.push(t('apps.builder.references.place.action', { label: reference.action.label }));
    if (reference.move) parts.push(t('apps.builder.references.place.move'));
    if (reference.role) parts.push(t('apps.builder.references.place.role', { name: reference.role.name }));
    return parts.join(' › ');
  };
}

export function AppReferencesList({ conflict }: { conflict: AppReferencesConflict }) {
  const t = useT();
  const placeWords = usePlaceWords();
  return (
    <div
      className="space-y-2 rounded-md border border-warning bg-warning-subtle px-3 py-2"
      data-testid="app-references"
    >
      <p className="text-xs font-medium text-warning">{t('apps.builder.references.title')}</p>
      <ul className="space-y-1 text-xs text-fg-secondary">
        {conflict.references.map((reference, index) => {
          const place = placeWords(reference);
          return (
            <li key={`${reference.appId}-${index}`} className="flex items-start gap-1.5">
              <AppWindow size={12} className="mt-0.5 flex-shrink-0 text-fg-muted" />
              <span className="min-w-0">
                <a href={appBuilderHref(reference.appId)} className="font-medium text-primary-fg hover:underline">
                  {reference.name}
                </a>
                {place && <span className="text-fg-muted"> · {place}</span>}
              </span>
            </li>
          );
        })}
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
