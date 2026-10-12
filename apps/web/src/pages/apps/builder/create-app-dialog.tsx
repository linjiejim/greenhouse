/**
 * "New app" — the one way to create an app by hand, from a Base's page (the
 * Base is given) and from the app center (the person picks a Base they build,
 * or a new private one): a name, an optional description, an icon and a
 * colour → `POST /api/apps`. It starts as a draft with one empty page and one
 * role that sees it, named in the builder's language (their content to
 * rename) — then the builder opens. The server checks who may build there;
 * only the Base's owner publishes it later (D2).
 *
 * A new Base is created once: if creating the app then fails, the dialog
 * keeps that Base chosen, so trying again only creates the app.
 */

import { useState } from 'react';
import { APP_LIMITS, type AppAccent, type AppDraftView, type AppIconName, type AppSpec } from '@greenhouse/types/apps';
import { Button, Dialog, Input, Select, Spinner, Textarea } from '../../../components/ui';
import { FormActions, FormError, FormField } from '../../../components/form';
import { createApp } from '../../../lib/api/apps-builder';
import { createTableBase } from '../../../lib/api/tables';
import { useT } from '../../../lib/i18n';
import { useBuilderBases } from '../center/use-builder-bases';
import { AppAccentPicker, AppIconPicker } from './identity-fields';
import { CARD_SIZES } from './spec-model';
import { PanelSection } from './properties/common';

/** The Base choice that creates a new one. */
const NEW_BASE = 'new';

/** The draft a new app starts from, named in the builder's language (their content to rename). */
export function starterSpec(pageTitle: string, roleName: string): AppSpec {
  return {
    version: 1,
    pages: [
      {
        id: 'home',
        title: pageTitle,
        cards: [{ id: 'intro', kind: 'text', layout: { x: 0, y: 0, ...CARD_SIZES.text }, markdown: '' }],
      },
    ],
    roles: [{ key: 'member', name: roleName, pages: 'all', tables: [] }],
  };
}

export function CreateAppDialog({
  open,
  onClose,
  baseId,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  /** The Base to build on (a Base's page). Omitted: the person picks a Base they build, or a new one. */
  baseId?: number;
  onCreated: (view: AppDraftView) => void;
}) {
  const t = useT();
  const choosing = baseId === undefined;
  const bases = useBuilderBases(open && choosing);
  const [baseChoice, setBaseChoice] = useState('');
  const [baseName, setBaseName] = useState('');
  /** The Base this dialog already created (a failed create keeps it chosen, so a retry does not make another). */
  const [createdBase, setCreatedBase] = useState<{ id: number; name: string } | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [icon, setIcon] = useState<AppIconName>('app');
  const [accent, setAccent] = useState<AppAccent>('brand');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const listed = bases.kind === 'ready' ? bases.bases.map((base) => ({ id: base.id, name: base.name })) : [];
  const available =
    createdBase && !listed.some((base) => base.id === createdBase.id) ? [...listed, createdBase] : listed;
  // With no Base to build on, creating one is the only choice.
  const choice = baseChoice || (bases.kind === 'ready' && available.length === 0 ? NEW_BASE : '');
  const creatingBase = choosing && choice === NEW_BASE;
  const ready = name.trim() !== '' && (!choosing || (creatingBase ? baseName.trim() !== '' : choice !== '')) && !saving;

  const create = async () => {
    if (!ready) return;
    setSaving(true);
    setError('');
    try {
      let target = baseId ?? Number(choice);
      if (creatingBase) {
        const made = (await createTableBase({ name: baseName.trim(), visibility: 'private' })).base;
        setCreatedBase({ id: made.id, name: made.name });
        setBaseChoice(String(made.id));
        target = made.id;
      }
      const view = await createApp({
        baseId: target,
        name: name.trim(),
        description: description.trim() || null,
        icon,
        accent,
        spec: starterSpec(t('apps.builder.create.starterPage'), t('apps.builder.create.starterRole')),
      });
      setName('');
      setDescription('');
      onCreated(view);
    } catch (createError) {
      setError(
        createError instanceof Error && createError.message ? createError.message : t('apps.builder.create.failed'),
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title={t('apps.builder.create.title')} size={choosing ? 'lg' : 'md'}>
      <div className="space-y-4" data-testid="app-create-dialog">
        <FormField label={t('apps.builder.create.name')} required>
          <Input
            value={name}
            maxLength={APP_LIMITS.nameLength}
            placeholder={t('apps.builder.create.namePlaceholder')}
            onChange={(event) => setName(event.target.value)}
            data-testid="app-create-name"
          />
        </FormField>
        {choosing && (
          <>
            <FormField label={t('apps.builder.create.base')} required>
              {bases.kind === 'loading' ? (
                <div className="flex h-9 items-center">
                  <Spinner className="h-4 w-4 text-fg-faint" />
                </div>
              ) : (
                <Select
                  value={choice}
                  onChange={(event) => setBaseChoice(event.target.value)}
                  data-testid="app-create-base"
                >
                  <option value="">{t('apps.builder.create.basePlaceholder')}</option>
                  {available.map((base) => (
                    <option key={base.id} value={String(base.id)}>
                      {base.name}
                    </option>
                  ))}
                  <option value={NEW_BASE}>{t('apps.builder.create.newBase')}</option>
                </Select>
              )}
            </FormField>
            {bases.kind === 'failed' && <p className="text-xs text-danger">{t('apps.builder.create.basesFailed')}</p>}
            {bases.kind === 'ready' && available.length === 0 && (
              <p className="text-xs text-fg-muted">{t('apps.builder.create.noBases')}</p>
            )}
            {creatingBase && (
              <FormField label={t('apps.builder.create.baseName')} required>
                <Input
                  value={baseName}
                  maxLength={120}
                  onChange={(event) => setBaseName(event.target.value)}
                  data-testid="app-create-base-name"
                />
              </FormField>
            )}
          </>
        )}
        <PanelSection title={t('apps.builder.create.optional')} defaultOpen={false}>
          <FormField label={t('apps.builder.create.description')}>
            <Textarea
              rows={2}
              value={description}
              maxLength={500}
              onChange={(event) => setDescription(event.target.value)}
            />
          </FormField>
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-fg-secondary">{t('apps.builder.settings.icon')}</p>
            <AppIconPicker
              label={t('apps.builder.settings.icon')}
              value={icon}
              onChange={(next) => next && setIcon(next)}
            />
          </div>
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-fg-secondary">{t('apps.builder.settings.accent')}</p>
            <AppAccentPicker
              label={t('apps.builder.settings.accent')}
              value={accent}
              icon={icon}
              onChange={setAccent}
            />
          </div>
        </PanelSection>
        {choosing && <p className="text-xs text-fg-faint">{t('apps.builder.create.publishNote')}</p>}
        <FormError>{error}</FormError>
        <FormActions>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            {t('common.cancel')}
          </Button>
          <Button disabled={!ready} onClick={() => void create()} data-testid="app-create-submit">
            {saving ? t('common.saving') : t('apps.builder.create.submit')}
          </Button>
        </FormActions>
      </div>
    </Dialog>
  );
}
