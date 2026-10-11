/**
 * "New app": pick a Base the caller builds (or create a new one), name the
 * app, choose its icon and colour → `POST /api/apps` (a draft with the starter
 * spec) → the builder. Only the Base's owner publishes it later (D2).
 */

import { useState } from 'react';
import { APP_ACCENTS, APP_ICONS, type AppAccent, type AppIconName } from '@greenhouse/types/apps';
import { AppBadge } from '../../../components/apps';
import { FormError, FormField } from '../../../components/form';
import { Button, Dialog, Input, Select, Spinner, Textarea } from '../../../components/ui';
import { createApp } from '../../../lib/api/apps';
import { createTableBase } from '../../../lib/api/tables';
import { appBuilderHref } from '../../../lib/app-routes';
import { useT } from '../../../lib/i18n';
import { useAppsStore } from '../../../stores/apps-store';
import { useBuilderBases } from './use-builder-bases';

const NEW_BASE = 'new';

function IconChoice({
  value,
  accent,
  onChange,
}: {
  value: AppIconName;
  accent: AppAccent;
  onChange: (icon: AppIconName) => void;
}) {
  const t = useT();
  return (
    <div role="radiogroup" aria-label={t('apps.center.newDialog.icon')} className="flex flex-wrap gap-1.5">
      {APP_ICONS.map((icon) => (
        <button
          key={icon}
          type="button"
          role="radio"
          aria-checked={value === icon}
          aria-label={t(`apps.center.icon.${icon}`)}
          onClick={() => onChange(icon)}
          className={`rounded-lg p-0.5 transition ${value === icon ? 'ring-2 ring-primary-500' : 'hover:bg-surface-muted'}`}
        >
          <AppBadge icon={icon} accent={accent} size="sm" />
        </button>
      ))}
    </div>
  );
}

function AccentChoice({ value, onChange }: { value: AppAccent; onChange: (accent: AppAccent) => void }) {
  const t = useT();
  return (
    <div role="radiogroup" aria-label={t('apps.center.newDialog.accent')} className="flex flex-wrap gap-1.5">
      {APP_ACCENTS.map((accent) => (
        <button
          key={accent}
          type="button"
          role="radio"
          aria-checked={value === accent}
          aria-label={t(`apps.center.accent.${accent}`)}
          onClick={() => onChange(accent)}
          className={`rounded-lg p-0.5 transition ${value === accent ? 'ring-2 ring-primary-500' : 'hover:bg-surface-muted'}`}
        >
          <AppBadge icon="app" accent={accent} size="sm" />
        </button>
      ))}
    </div>
  );
}

export function NewAppDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const bases = useBuilderBases(open);
  const reloadShelves = useAppsStore((state) => state.load);
  const [baseChoice, setBaseChoice] = useState('');
  const [baseName, setBaseName] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [icon, setIcon] = useState<AppIconName>('app');
  const [accent, setAccent] = useState<AppAccent>('brand');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const available = bases.kind === 'ready' ? bases.bases : [];
  // With no Base to build on, creating one is the only choice.
  const choice = baseChoice || (bases.kind === 'ready' && available.length === 0 ? NEW_BASE : '');
  const creatingBase = choice === NEW_BASE;
  const ready = name.trim() !== '' && (creatingBase ? baseName.trim() !== '' : choice !== '');

  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setError('');
    try {
      const baseId = creatingBase
        ? (await createTableBase({ name: baseName.trim(), visibility: 'private' })).base.id
        : Number(choice);
      const draft = await createApp({
        baseId,
        name: name.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        icon,
        accent,
      });
      void reloadShelves(true);
      onClose();
      window.location.hash = appBuilderHref(draft.app.id);
    } catch (createError) {
      setError(
        createError instanceof Error && createError.message ? createError.message : t('apps.center.newDialog.failed'),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title={t('apps.center.newDialog.title')} size="lg">
      <div className="space-y-4" data-testid="new-app-dialog">
        <FormField label={t('apps.center.newDialog.base')} required>
          {bases.kind === 'loading' ? (
            <div className="flex h-9 items-center">
              <Spinner className="h-4 w-4 text-fg-faint" />
            </div>
          ) : (
            <Select value={choice} onChange={(event) => setBaseChoice(event.target.value)} data-testid="new-app-base">
              <option value="">{t('apps.center.newDialog.basePlaceholder')}</option>
              {available.map((base) => (
                <option key={base.id} value={String(base.id)}>
                  {base.name}
                </option>
              ))}
              <option value={NEW_BASE}>{t('apps.center.newDialog.newBase')}</option>
            </Select>
          )}
        </FormField>
        {bases.kind === 'failed' && <p className="text-xs text-danger">{t('apps.center.newDialog.basesFailed')}</p>}
        {bases.kind === 'ready' && available.length === 0 && (
          <p className="text-xs text-fg-muted">{t('apps.center.newDialog.noBases')}</p>
        )}
        {creatingBase && (
          <FormField label={t('apps.center.newDialog.baseName')} required>
            <Input value={baseName} onChange={(event) => setBaseName(event.target.value)} maxLength={120} />
          </FormField>
        )}
        <FormField label={t('apps.center.newDialog.name')} required>
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={60}
            data-testid="new-app-name"
          />
        </FormField>
        <FormField label={t('apps.center.newDialog.description')}>
          <Textarea rows={2} value={description} onChange={(event) => setDescription(event.target.value)} />
        </FormField>
        <div>
          <p className="mb-1.5 text-xs font-medium text-fg-secondary">{t('apps.center.newDialog.icon')}</p>
          <IconChoice value={icon} accent={accent} onChange={setIcon} />
        </div>
        <div>
          <p className="mb-1.5 text-xs font-medium text-fg-secondary">{t('apps.center.newDialog.accent')}</p>
          <AccentChoice value={accent} onChange={setAccent} />
        </div>
        <p className="text-xs text-fg-faint">{t('apps.center.newDialog.publishNote')}</p>
        <FormError>{error}</FormError>
        <div className="flex justify-end gap-2 border-t border-edge pt-4">
          <Button variant="outline" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => void submit()} disabled={!ready || busy} data-testid="new-app-create">
            {busy ? t('apps.center.newDialog.creating') : t('apps.center.newDialog.create')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
