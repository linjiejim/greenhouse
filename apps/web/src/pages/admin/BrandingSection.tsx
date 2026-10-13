/** 管理 → 品牌 (ADM-11): the workspace's name and main colour, shown on sign-in and in the app. */

import { useState, type FormEvent } from 'react';
import { Button, Field, Input } from '@greenhouse/ui/kit';
import { ApiClientError } from '@greenhouse/contract/client';
import { useQueryClient } from '@tanstack/react-query';
import { useNotify } from '../../app/notify';
import { useSession } from '../../app/session';
import { keys } from '../../data/query';
import { api } from '../../lib/api';
import { useI18n } from '../../lib/i18n';

const HEX = /^#[0-9A-Fa-f]{6}$/;

export function BrandingSection() {
  const { t } = useI18n();
  const notify = useNotify();
  const client = useQueryClient();
  const { bootstrap } = useSession();
  const [name, setName] = useState(bootstrap?.name ?? '');
  const [color, setColor] = useState(bootstrap?.primary_color ?? '');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const dirty = name !== (bootstrap?.name ?? '') || color !== (bootstrap?.primary_color ?? '');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return setError(t('request.required', { name: t('branding.name') }));
    if (color && !HEX.test(color)) return setError(t('branding.colorFormat'));
    setSaving(true);
    try {
      const saved = await api.admin.branding({ name: name.trim(), primary_color: color || null });
      client.setQueryData(keys.bootstrap, saved);
      notify(t('common.saved'));
    } catch (caught) {
      setError(caught instanceof ApiClientError ? caught.message : t('common.error'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="app-form" onSubmit={(event) => void submit(event)} aria-label={t('admin.branding')}>
      <Field label={t('branding.name')} required error={error || undefined}>
        <Input
          value={name}
          maxLength={60}
          onChange={(event) => {
            setName(event.target.value);
            setError('');
          }}
        />
      </Field>
      <Field label={t('branding.color')} description={t('branding.colorHint')}>
        <span className="app-color-row">
          <input
            type="color"
            className="app-color-swatch"
            aria-label={t('branding.color')}
            value={HEX.test(color) ? color : '#235d4d'}
            onChange={(event) => setColor(event.target.value)}
          />
          <Input value={color} placeholder="#235D4D" maxLength={7} onChange={(event) => setColor(event.target.value)} />
        </span>
      </Field>
      <div>
        <Button kind="primary" type="submit" loading={saving} disabled={!dirty}>
          {t('common.save')}
        </Button>
      </div>
    </form>
  );
}
