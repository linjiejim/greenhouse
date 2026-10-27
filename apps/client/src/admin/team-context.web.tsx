/**
 * Team context (GET/PUT /api/admin/team-context): what every member's agent receives as the
 * team's context over MCP — overview, conventions and glossary text, the convention documents and
 * the glossary document (when a plugin offers team documents: `document_source`, `candidates`),
 * and the workspace time zone scheduled work runs in.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { get, put } from '../api/client';
import { useResource } from '../data/use-resource';
import { usePrefs } from '../store/prefs';
import { useT, localeOf } from '../lib/i18n';
import { Icon } from '../ui/core';
import { toast } from '../ui/toast';
import { AdminPage, Badge, Card, Field, SectionState } from './kit.web';
import { useWrite } from './use-write';
import { dateTimeLabel } from './format';

interface DocRef {
  doc_id: string;
  title: string | null;
  problem: 'missing' | 'not_team' | 'archived' | null;
}
interface TeamContextView {
  markdown?: { overview: string; conventions: string; glossary: string };
  document_source?: boolean;
  conventions: DocRef[];
  glossary: DocRef | null;
  timezone: string | null;
  effective_timezone: string;
  candidates: { doc_id: string; title: string }[];
  retro_next_run_at: string | null;
}

const MAX_CONVENTION_DOCS = 10;
const TEXTS = ['overview', 'conventions', 'glossary'] as const;

function Problem({ problem }: { problem: DocRef['problem'] }) {
  const t = useT();
  return problem ? (
    <Badge tone="warning" title={t('admin.teamContext.problemHint')}>
      {t(`admin.teamContext.problem.${problem}`)}
    </Badge>
  ) : null;
}

export default function TeamContextSection() {
  const t = useT();
  const lang = usePrefs((s) => s.lang);
  const data = useResource(useCallback(() => get<TeamContextView>('/api/admin/team-context'), []));
  const view = data.data;
  const [markdown, setMarkdown] = useState({ overview: '', conventions: '', glossary: '' });
  const [timezone, setTimezone] = useState('');
  const [conventions, setConventions] = useState<DocRef[]>([]);
  const [glossary, setGlossary] = useState('');
  const [adding, setAdding] = useState('');
  const { busy, run } = useWrite();
  useEffect(() => {
    if (!view) return;
    if (view.markdown) setMarkdown(view.markdown);
    setTimezone(view.timezone ?? '');
    setConventions(view.conventions);
    setGlossary(view.glossary?.doc_id ?? '');
  }, [view]);
  const addable = useMemo(
    () => (view?.candidates ?? []).filter((doc) => !conventions.some((c) => c.doc_id === doc.doc_id)),
    [view, conventions],
  );
  const save = async () => {
    const answer = await run(
      () =>
        put<TeamContextView>('/api/admin/team-context', {
          markdown,
          timezone: timezone.trim() || null,
          ...(view?.document_source
            ? { conventions: conventions.map((doc) => doc.doc_id), glossary: glossary || null }
            : {}),
        }),
      t('admin.teamContext.saveFailed'),
    );
    if (!answer) return;
    data.setData(answer);
    toast(t('admin.teamContext.saved'));
  };
  if (!view)
    return (
      <AdminPage title={t('admin.sections.team-context')}>
        <SectionState loading={data.loading} error={data.error} retry={() => void data.refresh()} />
      </AdminPage>
    );
  const glossaryRef = view.glossary && view.glossary.doc_id === glossary ? view.glossary : null;
  return (
    <AdminPage title={t('admin.sections.team-context')} testID="admin-team-context">
      <div className="gh-admin-settings">
        <p className="gh-hint">{t('admin.teamContext.intro')}</p>
        <Card title={t('admin.teamContext.text')} icon="file">
          <div className="gh-form" style={{ padding: 0 }}>
            {TEXTS.map((key) => (
              <Field key={key} label={t(`admin.teamContext.markdown.${key}`)}>
                {(id) => (
                  <textarea
                    id={id}
                    rows={5}
                    value={markdown[key]}
                    onChange={(e) => setMarkdown((m) => ({ ...m, [key]: e.target.value }))}
                  />
                )}
              </Field>
            ))}
          </div>
        </Card>
        {view.document_source ? (
          <>
            <Card
              title={t('admin.teamContext.conventionsTitle')}
              icon="book"
              hint={t('admin.teamContext.conventionsHint', { n: MAX_CONVENTION_DOCS })}
            >
              <div className="gh-form" style={{ padding: 0 }} data-testid="team-context-conventions">
                {conventions.length ? (
                  conventions.map((doc) => (
                    <div key={doc.doc_id} className="gh-admin-tool">
                      <span title={doc.title ?? doc.doc_id}>{doc.title ?? doc.doc_id}</span>
                      <Problem problem={doc.problem} />
                      <button
                        type="button"
                        className="gh-icon-button"
                        aria-label={t('admin.teamContext.remove', { title: doc.title ?? doc.doc_id })}
                        onClick={() => setConventions((list) => list.filter((c) => c.doc_id !== doc.doc_id))}
                      >
                        <Icon name="x" size={14} />
                      </button>
                    </div>
                  ))
                ) : (
                  <p className="gh-hint" style={{ margin: 0 }}>
                    {t('admin.teamContext.noConventions')}
                  </p>
                )}
                {conventions.length < MAX_CONVENTION_DOCS ? (
                  <div className="gh-button-row">
                    <select
                      className="gh-input"
                      aria-label={t('admin.teamContext.pickDocument')}
                      value={adding}
                      onChange={(e) => setAdding(e.target.value)}
                      style={{ minWidth: 280 }}
                    >
                      <option value="">{t('admin.teamContext.pickDocument')}</option>
                      {addable.map((doc) => (
                        <option key={doc.doc_id} value={doc.doc_id}>
                          {doc.title}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="gh-secondary-button"
                      disabled={!adding}
                      onClick={() => {
                        const doc = view.candidates.find((c) => c.doc_id === adding);
                        if (doc)
                          setConventions((list) => [...list, { doc_id: doc.doc_id, title: doc.title, problem: null }]);
                        setAdding('');
                      }}
                    >
                      {t('admin.teamContext.add')}
                    </button>
                  </div>
                ) : null}
              </div>
            </Card>
            <Card title={t('admin.teamContext.glossaryTitle')} icon="note" hint={t('admin.teamContext.glossaryHint')}>
              <div className="gh-button-row">
                <select
                  className="gh-input"
                  aria-label={t('admin.teamContext.glossaryTitle')}
                  value={glossary}
                  onChange={(e) => setGlossary(e.target.value)}
                  style={{ minWidth: 280 }}
                >
                  <option value="">{t('admin.teamContext.glossaryNone')}</option>
                  {glossaryRef && !view.candidates.some((doc) => doc.doc_id === glossaryRef.doc_id) ? (
                    <option value={glossaryRef.doc_id}>{glossaryRef.title ?? glossaryRef.doc_id}</option>
                  ) : null}
                  {view.candidates.map((doc) => (
                    <option key={doc.doc_id} value={doc.doc_id}>
                      {doc.title}
                    </option>
                  ))}
                </select>
                {glossaryRef ? <Problem problem={glossaryRef.problem} /> : null}
              </div>
            </Card>
          </>
        ) : null}
        <Card title={t('admin.teamContext.timezoneTitle')} icon="clock">
          <Field
            label={t('admin.teamContext.timezoneLabel')}
            help={[
              t('admin.teamContext.timezoneDefault', { zone: view.effective_timezone }),
              view.retro_next_run_at
                ? t('admin.teamContext.nextRun', { date: dateTimeLabel(view.retro_next_run_at, localeOf(lang)) ?? '' })
                : '',
            ]
              .filter(Boolean)
              .join(' ')}
          >
            {(id) => (
              <input
                id={id}
                className="gh-mono"
                value={timezone}
                placeholder={view.effective_timezone}
                onChange={(e) => setTimezone(e.target.value)}
                style={{ maxWidth: 320 }}
              />
            )}
          </Field>
        </Card>
        <div className="gh-savebar">
          <button className="gh-primary" disabled={busy} onClick={() => void save()} data-testid="team-context-save">
            {t('common.save')}
          </button>
        </div>
      </div>
    </AdminPage>
  );
}
