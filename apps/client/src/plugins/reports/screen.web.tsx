/**
 * Report templates in the browser (the Reports plugin's `reports` page): the team's templates and
 * my drafts; New Template and a row open the editor (an `lg` dialog): name, kind, formats, where it
 * lives (the team, or a draft only I see), cover fields and ordered sections (key, title, content
 * kind, required, guidance for whoever writes it). The station's own rule checks the definition
 * before it is sent (./template-draft.ts); Preview renders it with sample content as a PDF; Delete
 * confirms first. A template I cannot edit opens read-only. The phone keeps the read-only list.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useResource } from '../../data/use-resource';
import { useT } from '../../lib/i18n';
import { relativeTimeNow } from '../../lib/time-words';
import {
  REPORT_COVER_FIELD_KEYS,
  REPORT_FORMATS_BY_KIND,
  REPORT_KINDS,
  REPORT_SECTION_CONTENT_KINDS,
  REPORT_TEMPLATE_LIMITS,
  type ReportTemplateView,
} from '../../shared/reports';
import { usePrefs } from '../../store/prefs';
import { Icon } from '../../ui/core';
import { alertError, confirmAction } from '../../ui/dialogs';
import { Place, PlaceEmpty } from '../../ui/place.web';
import { toast } from '../../ui/toast';
import { AdminDialog, Badge, Callout, Field } from '../../admin/kit.web';
import { useWrite } from '../../admin/use-write';
import { createTemplate, deleteTemplate, listTemplates, previewTemplate, updateTemplate } from './api';
import {
  addSection,
  draftOf,
  draftProblems,
  moveSection,
  removeSection,
  templateBody,
  toggleFormat,
  updateSection,
  withKind,
  type TemplateDraft,
} from './template-draft';

type Open = { template?: ReportTemplateView } | null;

export function ReportTemplatesScreen({ title }: { title: string }) {
  const t = useT();
  const list = useResource(useCallback(() => listTemplates(), []));
  const [open, setOpen] = useState<Open>(null);
  useEffect(() => {
    const refresh = () => void list.refresh();
    window.addEventListener('greenhouse:refresh', refresh);
    return () => window.removeEventListener('greenhouse:refresh', refresh);
  });
  const templates = list.data?.templates ?? [];
  return (
    <Place
      title={title}
      actions={
        <>
          <button onClick={() => void list.refresh()} disabled={list.loading} aria-label={t('common.refresh')}>
            <Icon name="refresh" size={16} />
          </button>
          <button className="gh-primary" onClick={() => setOpen({})} data-testid="template-new">
            {t('reportTemplates.new')}
          </button>
        </>
      }
    >
      <div className="gh-place-scroll">
        {!list.data ? (
          <PlaceEmpty
            loading={list.loading}
            error={list.error ? list.error.message || t('places.pluginError') : null}
            retry={list.error?.status === 403 ? undefined : () => void list.refresh()}
          />
        ) : !templates.length ? (
          <PlaceEmpty icon="file" title={t('reportTemplates.empty')} message={t('reportTemplates.emptyHint')} />
        ) : (
          <ul className="gh-resource-list" data-testid="templates-list">
            {templates.map((template) => (
              <li
                key={template.id}
                data-open=""
                role="button"
                tabIndex={0}
                aria-label={template.name}
                onClick={() => setOpen({ template })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setOpen({ template });
                  }
                }}
              >
                <span className="gh-resource-icon">
                  <Icon
                    name={template.kind === 'presentation' ? 'chart' : 'file'}
                    size={18}
                    color="var(--gh-accent-text)"
                  />
                </span>
                <div className="gh-resource-body">
                  <strong>{template.name}</strong>
                  {template.description ? <p>{template.description}</p> : null}
                  <div className="gh-resource-tags">
                    <span>{t(`reportTemplates.kind.${template.kind}`)}</span>
                    <span>{template.formats.map((f) => t(`reportTemplates.format.${f}`)).join(' · ')}</span>
                    <span>{t('reportTemplates.sectionCount', { n: template.sections.length })}</span>
                  </div>
                </div>
                <div className="gh-resource-meta">
                  {template.visibility === 'personal' ? (
                    <Badge tone="warning">{t('reportTemplates.draft')}</Badge>
                  ) : template.is_default ? (
                    <Badge tone="info">{t('reportTemplates.builtIn')}</Badge>
                  ) : (
                    <Badge tone="success">{t('reportTemplates.team')}</Badge>
                  )}
                  <small>
                    {[template.owner_name, relativeTimeNow(template.updated_at)].filter(Boolean).join(' · ')}
                  </small>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      {open ? (
        <TemplateEditor existing={open.template} close={() => setOpen(null)} changed={() => void list.refresh()} />
      ) : null}
    </Place>
  );
}

function TemplateEditor({
  existing,
  close,
  changed,
}: {
  existing?: ReportTemplateView;
  close: () => void;
  changed: () => void;
}) {
  const t = useT();
  const lang = usePrefs((s) => s.lang);
  const [draft, setDraft] = useState<TemplateDraft>(() => draftOf(existing));
  const [tried, setTried] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const { busy, run } = useWrite();
  const readOnly = !!existing && !existing.can_edit;
  const problems = draftProblems(draft);
  const L = REPORT_TEMPLATE_LIMITS;

  const save = async () => {
    setTried(true);
    if (problems.length || readOnly) return;
    const body = templateBody(draft);
    const answer = await run(
      () => (existing ? updateTemplate(existing.id, body) : createTemplate(body)),
      t('reportTemplates.saveFailed'),
    );
    if (!answer) return;
    toast(
      existing ? t('reportTemplates.saved') : t('reportTemplates.created', { name: answer.template.name }),
      'check',
    );
    changed();
    close();
  };
  const remove = async () => {
    if (!existing) return;
    const sure = await confirmAction({
      title: t('reportTemplates.deleteTitle', { name: existing.name }),
      message: t('reportTemplates.deleteHint'),
      confirmLabel: t('reportTemplates.delete'),
      destructive: true,
    });
    if (!sure) return;
    const answer = await run(() => deleteTemplate(existing.id), t('reportTemplates.deleteFailed'));
    if (!answer) return;
    toast(t('reportTemplates.deleted', { name: existing.name }), 'check');
    changed();
    close();
  };
  const preview = async () => {
    setTried(true);
    if (problems.length) return;
    setPreviewing(true);
    const answer = await previewTemplate(templateBody(draft), lang === 'en' ? 'en' : 'zh');
    setPreviewing(false);
    if (typeof answer === 'string') {
      alertError(t('reportTemplates.previewFailed'), answer);
      return;
    }
    const url = URL.createObjectURL(answer);
    window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };
  const cover = (key: (typeof REPORT_COVER_FIELD_KEYS)[number]) => draft.cover_fields.find((f) => f.key === key);
  const setCover = (key: (typeof REPORT_COVER_FIELD_KEYS)[number], on: boolean, required = false) =>
    setDraft((d) => ({
      ...d,
      cover_fields: REPORT_COVER_FIELD_KEYS.flatMap((k) => {
        if (k !== key) {
          const kept = d.cover_fields.find((f) => f.key === k);
          return kept ? [kept] : [];
        }
        return on ? [{ key, required }] : [];
      }),
    }));

  return (
    <AdminDialog
      size="lg"
      title={
        existing
          ? readOnly
            ? existing.name
            : t('reportTemplates.editTitle', { name: existing.name })
          : t('reportTemplates.newTitle')
      }
      onClose={close}
      testID="template-editor"
      footer={
        <>
          <span className="gh-dialog-footer-lead">
            {existing?.can_edit ? (
              <button
                type="button"
                className="gh-secondary-button gh-danger"
                onClick={() => void remove()}
                disabled={busy}
              >
                {t('reportTemplates.delete')}
              </button>
            ) : null}
            <button type="button" className="gh-secondary-button" onClick={() => void preview()} disabled={previewing}>
              {previewing ? t('common.loading') : t('reportTemplates.preview')}
            </button>
          </span>
          <button type="button" className="gh-secondary-button" onClick={close}>
            {readOnly ? t('common.close') : t('common.cancel')}
          </button>
          {readOnly ? null : (
            <button type="submit" form="report-template" className="gh-primary" disabled={busy}>
              {existing ? t('common.save') : t('reportTemplates.create')}
            </button>
          )}
        </>
      }
    >
      <form
        id="report-template"
        className="gh-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <fieldset disabled={readOnly} style={{ border: 0, padding: 0, margin: 0, display: 'contents' }}>
          {readOnly ? <Callout tone="info">{t('reportTemplates.readOnly')}</Callout> : null}
          {tried && problems.length ? (
            <Callout tone="danger" testID="template-problems">
              <ul style={{ margin: 0, paddingLeft: 16 }}>
                {problems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            </Callout>
          ) : null}
          <div className="gh-form-grid">
            <Field label={t('reportTemplates.name')} required>
              {(id) => (
                <input
                  id={id}
                  maxLength={L.name}
                  value={draft.name}
                  onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                />
              )}
            </Field>
            <Field label={t('reportTemplates.kindLabel')}>
              {(id) => (
                <select
                  id={id}
                  value={draft.kind}
                  onChange={(e) => setDraft((d) => withKind(d, e.target.value as TemplateDraft['kind']))}
                >
                  {REPORT_KINDS.map((kind) => (
                    <option key={kind} value={kind}>
                      {t(`reportTemplates.kind.${kind}`)}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          </div>
          <Field label={t('reportTemplates.description')} help={t('reportTemplates.descriptionHint')}>
            {(id) => (
              <textarea
                id={id}
                rows={2}
                maxLength={L.description}
                value={draft.description}
                onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
              />
            )}
          </Field>
          <div className="gh-form-grid">
            <div className="gh-field">
              <span className="gh-field-label">{t('reportTemplates.formats')}</span>
              <div className="gh-chip-row">
                {REPORT_FORMATS_BY_KIND[draft.kind].map((format, index) => (
                  <label key={format} className="gh-check">
                    <input
                      type="checkbox"
                      checked={draft.formats.includes(format)}
                      onChange={() => setDraft((d) => toggleFormat(d, format))}
                    />
                    <span>
                      {t(`reportTemplates.format.${format}`)}
                      {index === 0 ? <small>{t('reportTemplates.defaultFormat')}</small> : null}
                    </span>
                  </label>
                ))}
              </div>
            </div>
            <Field
              label={t('reportTemplates.visibility')}
              help={t(`reportTemplates.visibilityHint.${draft.visibility}`)}
            >
              {(id) => (
                <select
                  id={id}
                  value={draft.visibility}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, visibility: e.target.value as TemplateDraft['visibility'] }))
                  }
                >
                  <option value="team">{t('reportTemplates.team')}</option>
                  {existing?.is_default ? null : <option value="personal">{t('reportTemplates.draft')}</option>}
                </select>
              )}
            </Field>
          </div>

          <h4 className="gh-form-heading">{t('reportTemplates.cover')}</h4>
          <div className="gh-chip-row">
            {REPORT_COVER_FIELD_KEYS.map((key) => {
              const field = cover(key);
              return (
                <span key={key} className="gh-button-row" style={{ gap: 8 }}>
                  <label className="gh-check">
                    <input type="checkbox" checked={!!field} onChange={(e) => setCover(key, e.target.checked)} />
                    <span>{t(`reportTemplates.coverField.${key}`)}</span>
                  </label>
                  {field ? (
                    <label className="gh-check">
                      <input
                        type="checkbox"
                        checked={field.required}
                        onChange={(e) => setCover(key, true, e.target.checked)}
                      />
                      <span>
                        <small>{t('reportTemplates.required')}</small>
                      </span>
                    </label>
                  ) : null}
                </span>
              );
            })}
          </div>

          <h4 className="gh-form-heading">{t('reportTemplates.sections')}</h4>
          {draft.sections.map((section, index) => (
            <fieldset key={index} className="gh-form-section" data-testid={`template-section-${index}`}>
              <legend>{t('reportTemplates.sectionN', { n: index + 1 })}</legend>
              <div className="gh-button-row" style={{ justifyContent: 'flex-end' }}>
                <button
                  type="button"
                  className="gh-icon-button"
                  aria-label={t('reportTemplates.moveUp')}
                  disabled={index === 0}
                  onClick={() => setDraft((d) => moveSection(d, index, -1))}
                >
                  <Icon name="chevU" size={16} />
                </button>
                <button
                  type="button"
                  className="gh-icon-button"
                  aria-label={t('reportTemplates.moveDown')}
                  disabled={index === draft.sections.length - 1}
                  onClick={() => setDraft((d) => moveSection(d, index, 1))}
                >
                  <Icon name="chevD" size={16} />
                </button>
                <button
                  type="button"
                  className="gh-icon-button gh-danger"
                  aria-label={t('reportTemplates.removeSection')}
                  disabled={draft.sections.length === 1}
                  onClick={() => setDraft((d) => removeSection(d, index))}
                >
                  <Icon name="trash" size={16} />
                </button>
              </div>
              <div className="gh-form-grid">
                <Field label={t('reportTemplates.sectionTitle')} required>
                  {(id) => (
                    <input
                      id={id}
                      maxLength={L.sectionTitle}
                      value={section.title}
                      onChange={(e) => setDraft((d) => updateSection(d, index, { title: e.target.value }))}
                    />
                  )}
                </Field>
                <Field label={t('reportTemplates.sectionKey')} help={t('reportTemplates.sectionKeyHint')}>
                  {(id) => (
                    <input
                      id={id}
                      className="gh-mono"
                      maxLength={L.sectionKey}
                      value={section.key}
                      onChange={(e) => setDraft((d) => updateSection(d, index, { key: e.target.value.toLowerCase() }))}
                    />
                  )}
                </Field>
                <Field label={t('reportTemplates.content')}>
                  {(id) => (
                    <select
                      id={id}
                      value={section.content}
                      onChange={(e) =>
                        setDraft((d) => updateSection(d, index, { content: e.target.value as typeof section.content }))
                      }
                    >
                      {REPORT_SECTION_CONTENT_KINDS.map((kind) => (
                        <option key={kind} value={kind}>
                          {t(`reportTemplates.contentKind.${kind}`)}
                        </option>
                      ))}
                    </select>
                  )}
                </Field>
                <label className="gh-check" style={{ alignSelf: 'end' }}>
                  <input
                    type="checkbox"
                    checked={section.required}
                    onChange={(e) => setDraft((d) => updateSection(d, index, { required: e.target.checked }))}
                  />
                  <span>{t('reportTemplates.required')}</span>
                </label>
              </div>
              <Field label={t('reportTemplates.guidance')} help={t('reportTemplates.guidanceHint')}>
                {(id) => (
                  <textarea
                    id={id}
                    rows={2}
                    maxLength={L.guidance}
                    value={section.guidance}
                    onChange={(e) => setDraft((d) => updateSection(d, index, { guidance: e.target.value }))}
                  />
                )}
              </Field>
            </fieldset>
          ))}
          {draft.sections.length < L.sections ? (
            <div className="gh-button-row">
              <button type="button" className="gh-secondary-button" onClick={() => setDraft((d) => addSection(d))}>
                <Icon name="plus" size={14} />
                {t('reportTemplates.addSection')}
              </button>
            </div>
          ) : null}
        </fieldset>
      </form>
    </AdminDialog>
  );
}
