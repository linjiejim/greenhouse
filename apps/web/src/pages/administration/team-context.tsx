import React, { useEffect, useState } from 'react';
import { ModulePage } from '../../components/app/module-page';
import { SettingsPanel } from '../../components/settings';
import { FormField, FormError } from '../../components/form';
import { Button, Textarea, Input, Spinner, toast } from '../../components/ui';
import { useT } from '../../lib/i18n';
import { fetchTeamContextSettings, saveTeamContextSettings } from '../../lib/api/hub-context';
import { extensionSlots } from '../../extensions/index';
import type { TeamContextSettingsView } from '@greenhouse/types/hub-context';
export function TeamContextPanel() {
  const t = useT();
  const [view, setView] = useState<TeamContextSettingsView | null>(null);
  const [markdown, setMarkdown] = useState({ overview: '', conventions: '', glossary: '' });
  const [timezone, setTimezone] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    fetchTeamContextSettings()
      .then((v) => {
        setView(v);
        if (v.markdown) setMarkdown(v.markdown);
        setTimezone(v.timezone ?? '');
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  const save = async () => {
    setSaving(true);
    setError('');
    try {
      setView(await saveTeamContextSettings({ timezone: timezone || null, markdown }));
      toast(t('teamContext.saved'), 'success');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };
  return (
    <ModulePage moduleId="admin.team-context" layout="form">
      <SettingsPanel>
        <FormError>{error}</FormError>
        {!view ? (
          error ? null : (
            <Spinner />
          )
        ) : (
          <>
            {(['overview', 'conventions', 'glossary'] as const).map((key) => (
              <FormField key={key} label={t(`teamContext.markdown.${key}`)}>
                <Textarea
                  value={markdown[key]}
                  rows={6}
                  onChange={(e) => setMarkdown({ ...markdown, [key]: e.target.value })}
                />
              </FormField>
            ))}
            <FormField label={t('teamContext.timezoneLabel')}>
              <Input
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                placeholder={view.effective_timezone}
              />
            </FormField>
            <Button onClick={() => void save()} disabled={saving} data-testid="team-context-save">
              {t(saving ? 'common.saving' : 'common.save')}
            </Button>
          </>
        )}
        {extensionSlots('team-context.documents').map(({ component: Component }, index) => (
          <Component key={index} />
        ))}
      </SettingsPanel>
    </ModulePage>
  );
}
