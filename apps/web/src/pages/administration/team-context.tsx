/**
 * Administration › Team context — what every member's agent receives as the
 * team's context over MCP: the convention documents and the glossary (team
 * documents only), plus the workspace time zone the monthly retro runs in.
 *
 * Reads and writes /api/admin/team-context; the server re-checks team
 * visibility on every read, and a pick that stopped serving is flagged here.
 */

import React, { useEffect, useMemo, useState } from 'react';
import {
  DEFAULT_WORKSPACE_TIMEZONE,
  MAX_CONVENTION_DOCS,
  type TeamContextDocRef,
  type TeamContextSettingsView,
} from '@greenhouse/types/hub-context';
import { ModulePage } from '../../components/app/module-page';
import { SettingsPanel, SettingsSection } from '../../components/settings';
import { FormActions, FormError, FormField } from '../../components/form';
import { Button, IconButton, Input, Select, Spinner, Tag, toast } from '../../components/ui';
import { BookOpen, Clock, Library, X } from '../../lib/icons';
import { useT } from '../../lib/i18n';
import { formatDate } from '../../lib/utils';
import { fetchTeamContextSettings, saveTeamContextSettings } from '../../lib/api/hub-context';

function ProblemTag({ problem }: { problem: TeamContextDocRef['problem'] }) {
  const t = useT();
  if (!problem) return null;
  return (
    <Tag tone="warning" title={t('teamContext.problemHint')}>
      {t(`teamContext.problem.${problem}`)}
    </Tag>
  );
}

export function TeamContextPanel() {
  const t = useT();
  const [view, setView] = useState<TeamContextSettingsView | null>(null);
  const [conventions, setConventions] = useState<TeamContextDocRef[]>([]);
  const [glossary, setGlossary] = useState('');
  const [timezone, setTimezone] = useState('');
  const [adding, setAdding] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const apply = (next: TeamContextSettingsView) => {
    setView(next);
    setConventions(next.conventions);
    setGlossary(next.glossary?.doc_id ?? '');
    setTimezone(next.timezone ?? '');
    setAdding('');
  };

  useEffect(() => {
    fetchTeamContextSettings()
      .then(apply)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : t('teamContext.loadFailed')));
  }, [t]);

  const addable = useMemo(
    () => (view?.candidates ?? []).filter((doc) => !conventions.some((picked) => picked.doc_id === doc.doc_id)),
    [view, conventions],
  );

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      const next = await saveTeamContextSettings({
        conventions: conventions.map((doc) => doc.doc_id),
        glossary: glossary || null,
        timezone: timezone.trim() || null,
      });
      apply(next);
      toast(t('teamContext.saved'), 'success');
    } catch (err) {
      setError(err instanceof Error ? err.message : t('teamContext.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  if (!view) {
    return (
      <ModulePage moduleId="admin.team-context" layout="form">
        {error ? (
          <FormError>{error}</FormError>
        ) : (
          <div className="flex justify-center py-16">
            <Spinner className="h-5 w-5 text-fg-faint" />
          </div>
        )}
      </ModulePage>
    );
  }

  const glossaryRef = view.glossary && view.glossary.doc_id === glossary ? view.glossary : null;
  return (
    <ModulePage
      moduleId="admin.team-context"
      layout="form"
      notice={<p className="text-xs leading-5 text-fg-muted">{t('teamContext.intro')}</p>}
    >
      <SettingsPanel>
        <SettingsSection
          icon={BookOpen}
          title={t('teamContext.conventionsTitle')}
          description={t('teamContext.conventionsDesc', { count: MAX_CONVENTION_DOCS })}
        >
          <div className="space-y-3" data-testid="team-context-conventions">
            {conventions.length === 0 ? (
              <p className="text-xs text-fg-faint">{t('teamContext.noConventions')}</p>
            ) : (
              <ul className="divide-y divide-edge rounded-lg border border-edge">
                {conventions.map((doc) => (
                  <li key={doc.doc_id} className="flex items-center gap-2 px-3 py-2">
                    <span className="min-w-0 flex-1 truncate text-sm text-fg" title={doc.title ?? doc.doc_id}>
                      {doc.title ?? doc.doc_id}
                    </span>
                    <ProblemTag problem={doc.problem} />
                    <IconButton
                      label={t('teamContext.remove', { title: doc.title ?? doc.doc_id })}
                      onClick={() =>
                        setConventions((current) => current.filter((entry) => entry.doc_id !== doc.doc_id))
                      }
                    >
                      <X size={14} />
                    </IconButton>
                  </li>
                ))}
              </ul>
            )}
            {conventions.length < MAX_CONVENTION_DOCS && (
              <div className="flex items-center gap-2">
                <Select
                  size="sm"
                  value={adding}
                  aria-label={t('teamContext.pickDocument')}
                  onChange={(event) => setAdding(event.target.value)}
                >
                  <option value="">{t('teamContext.pickDocument')}</option>
                  {addable.map((doc) => (
                    <option key={doc.doc_id} value={doc.doc_id}>
                      {doc.title}
                    </option>
                  ))}
                </Select>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!adding}
                  onClick={() => {
                    const doc = view.candidates.find((entry) => entry.doc_id === adding);
                    if (!doc) return;
                    setConventions((current) => [...current, { doc_id: doc.doc_id, title: doc.title, problem: null }]);
                    setAdding('');
                  }}
                >
                  {t('teamContext.addConvention')}
                </Button>
              </div>
            )}
          </div>
        </SettingsSection>

        <SettingsSection
          icon={Library}
          title={t('teamContext.glossaryTitle')}
          description={t('teamContext.glossaryDesc')}
        >
          <div className="flex items-center gap-2">
            <Select
              size="sm"
              value={glossary}
              aria-label={t('teamContext.glossaryTitle')}
              onChange={(event) => setGlossary(event.target.value)}
              data-testid="team-context-glossary"
            >
              <option value="">{t('teamContext.glossaryNone')}</option>
              {glossaryRef && !view.candidates.some((doc) => doc.doc_id === glossaryRef.doc_id) && (
                <option value={glossaryRef.doc_id}>{glossaryRef.title ?? glossaryRef.doc_id}</option>
              )}
              {view.candidates.map((doc) => (
                <option key={doc.doc_id} value={doc.doc_id}>
                  {doc.title}
                </option>
              ))}
            </Select>
            {glossaryRef && <ProblemTag problem={glossaryRef.problem} />}
          </div>
        </SettingsSection>

        <SettingsSection
          icon={Clock}
          title={t('teamContext.timezoneTitle')}
          description={t('teamContext.timezoneDesc')}
        >
          <div className="space-y-2">
            <FormField
              label={t('teamContext.timezoneLabel')}
              help={t('teamContext.timezoneDefault', { zone: view.effective_timezone })}
            >
              <Input
                size="sm"
                value={timezone}
                placeholder={DEFAULT_WORKSPACE_TIMEZONE}
                onChange={(event) => setTimezone(event.target.value)}
              />
            </FormField>
            {view.retro_next_run_at && (
              <p className="text-xs text-fg-muted">
                {t('teamContext.nextRetro', { date: formatDate(view.retro_next_run_at) })}
              </p>
            )}
          </div>
        </SettingsSection>

        <FormError>{error}</FormError>
        <FormActions>
          <Button onClick={() => void save()} disabled={saving} data-testid="team-context-save">
            {saving ? t('common.saving') : t('common.save')}
          </Button>
        </FormActions>
      </SettingsPanel>
    </ModulePage>
  );
}
