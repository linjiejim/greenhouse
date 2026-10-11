/**
 * Create an app on a Base (owners and builders; the server checks): a name,
 * an optional description, an icon and a colour. It starts as a draft with
 * one empty page and one role that sees it — then the builder opens.
 */

import { useState } from 'react';
import { APP_LIMITS, type AppAccent, type AppDraftView, type AppIconName, type AppSpec } from '@greenhouse/types/apps';
import { Button, Dialog, Input, Textarea } from '../../../components/ui';
import { FormActions, FormError, FormField } from '../../../components/form';
import { createApp } from '../../../lib/api/apps-builder';
import { useT } from '../../../lib/i18n';
import { AppAccentPicker, AppIconPicker } from './identity-fields';
import { CARD_SIZES } from './spec-model';

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
  baseId: number;
  onCreated: (view: AppDraftView) => void;
}) {
  const t = useT();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [icon, setIcon] = useState<AppIconName>('app');
  const [accent, setAccent] = useState<AppAccent>('brand');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const create = async () => {
    setSaving(true);
    setError('');
    try {
      const view = await createApp({
        baseId,
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
      setError(createError instanceof Error ? createError.message : t('apps.builder.create.failed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title={t('apps.builder.create.title')} size="md">
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
          <AppAccentPicker label={t('apps.builder.settings.accent')} value={accent} icon={icon} onChange={setAccent} />
        </div>
        <FormError>{error}</FormError>
        <FormActions>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button disabled={saving || !name.trim()} onClick={() => void create()} data-testid="app-create-submit">
            {saving ? t('common.saving') : t('apps.builder.create.submit')}
          </Button>
        </FormActions>
      </div>
    </Dialog>
  );
}
