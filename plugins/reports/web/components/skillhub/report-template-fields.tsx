/**
 * The custom fields of the report template form (SkillHub › Report templates):
 * output formats, cover fields and the ordered section list.
 *
 * Each edits one value of the CrudPage form; the rules (key shape, limits,
 * which formats a kind allows) come from @greenhouse/types/reports, the same
 * module the server checks with, so the hints here never disagree with a
 * refusal.
 */

import React from 'react';
import {
  REPORT_COVER_FIELD_KEYS,
  REPORT_FORMATS_BY_KIND,
  REPORT_SECTION_CONTENT_KINDS,
  REPORT_SECTION_KEY_RE,
  REPORT_TEMPLATE_LIMITS,
  type ReportCoverFieldKey,
  type ReportFormat,
  type ReportKind,
  type ReportSectionContentKind,
  type ReportTemplateCoverField,
  type ReportTemplateSection,
} from '@greenhouse/types/reports';
import { Button, Checkbox, IconButton, Input, Select, Textarea } from '@greenhouse/web/extension-kit';
import { ArrowDown, ArrowUp, Plus, Trash2 } from '@greenhouse/web/extension-kit';
import { useT } from '@greenhouse/web/extension-kit';

export function FormatsField({
  kind,
  value,
  onChange,
}: {
  kind: ReportKind;
  value: ReportFormat[];
  onChange: (next: ReportFormat[]) => void;
}) {
  const t = useT();
  const allowed = REPORT_FORMATS_BY_KIND[kind];
  return (
    <div className="flex flex-wrap gap-4">
      {allowed.map((format) => (
        <Checkbox
          key={format}
          checked={value.includes(format)}
          onChange={(event) =>
            onChange(
              event.target.checked
                ? allowed.filter((f) => f === format || value.includes(f))
                : value.filter((f) => f !== format),
            )
          }
          label={t(`ext.reports.reportTemplates.format.${format}`)}
        />
      ))}
    </div>
  );
}

export function CoverFieldsField({
  value,
  onChange,
}: {
  value: ReportTemplateCoverField[];
  onChange: (next: ReportTemplateCoverField[]) => void;
}) {
  const t = useT();
  const find = (key: ReportCoverFieldKey) => value.find((field) => field.key === key);
  const set = (key: ReportCoverFieldKey, next: ReportTemplateCoverField | null) =>
    onChange(
      REPORT_COVER_FIELD_KEYS.flatMap((k) => {
        if (k === key) return next ? [next] : [];
        const existing = find(k);
        return existing ? [existing] : [];
      }),
    );
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {REPORT_COVER_FIELD_KEYS.map((key) => {
        const field = find(key);
        return (
          <div key={key} className="flex items-center justify-between gap-3 rounded-md border border-edge px-3 py-2">
            <Checkbox
              checked={Boolean(field)}
              onChange={(event) => set(key, event.target.checked ? { key, required: false } : null)}
              label={t(`ext.reports.reportTemplates.cover.${key}`)}
            />
            <Checkbox
              checked={field?.required ?? false}
              disabled={!field}
              onChange={(event) => set(key, { key, required: event.target.checked })}
              label={<span className="text-xs text-fg-muted">{t('ext.reports.reportTemplates.required')}</span>}
            />
          </div>
        );
      })}
    </div>
  );
}

function nextKey(sections: ReportTemplateSection[]): string {
  let n = sections.length + 1;
  while (sections.some((section) => section.key === `section_${n}`)) n++;
  return `section_${n}`;
}

export function SectionsField({
  value,
  onChange,
}: {
  value: ReportTemplateSection[];
  onChange: (next: ReportTemplateSection[]) => void;
}) {
  const t = useT();
  const update = (index: number, patch: Partial<ReportTemplateSection>) =>
    onChange(value.map((section, i) => (i === index ? { ...section, ...patch } : section)));
  const move = (index: number, by: -1 | 1) => {
    const next = [...value];
    const [item] = next.splice(index, 1);
    next.splice(index + by, 0, item!);
    onChange(next);
  };
  const keys = value.map((section) => section.key);

  return (
    <div className="space-y-3">
      {value.length === 0 && <p className="text-xs text-fg-muted">{t('ext.reports.reportTemplates.noSections')}</p>}
      {value.map((section, index) => {
        const keyProblem = !section.key
          ? t('ext.reports.reportTemplates.keyRequired')
          : !REPORT_SECTION_KEY_RE.test(section.key) || section.key.length > REPORT_TEMPLATE_LIMITS.sectionKey
            ? t('ext.reports.reportTemplates.keyShape')
            : keys.indexOf(section.key) !== index
              ? t('ext.reports.reportTemplates.keyDuplicate')
              : null;
        return (
          <div
            key={index}
            className="space-y-2 rounded-md border border-edge bg-surface-raised p-3"
            data-testid="report-template-section"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold text-fg-muted">{index + 1}</span>
              <Input
                size="sm"
                className="min-w-0 flex-1"
                value={section.title}
                maxLength={REPORT_TEMPLATE_LIMITS.sectionTitle}
                placeholder={t('ext.reports.reportTemplates.sectionTitle')}
                aria-label={t('ext.reports.reportTemplates.sectionTitle')}
                onChange={(event) => update(index, { title: event.target.value })}
              />
              <Input
                size="sm"
                className="w-40 font-mono"
                value={section.key}
                placeholder={t('ext.reports.reportTemplates.sectionKey')}
                aria-label={t('ext.reports.reportTemplates.sectionKey')}
                aria-invalid={Boolean(keyProblem)}
                onChange={(event) => update(index, { key: event.target.value.trim().toLowerCase() })}
              />
              <Select
                size="sm"
                inline
                value={section.content}
                aria-label={t('ext.reports.reportTemplates.sectionContent')}
                onChange={(event) => update(index, { content: event.target.value as ReportSectionContentKind })}
              >
                {REPORT_SECTION_CONTENT_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {t(`ext.reports.reportTemplates.content.${kind}`)}
                  </option>
                ))}
              </Select>
              <Checkbox
                checked={section.required}
                onChange={(event) => update(index, { required: event.target.checked })}
                label={<span className="text-xs">{t('ext.reports.reportTemplates.required')}</span>}
              />
              <div className="ml-auto flex items-center">
                <IconButton
                  size="compact"
                  label={t('ext.reports.reportTemplates.moveUp')}
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                >
                  <ArrowUp size={14} />
                </IconButton>
                <IconButton
                  size="compact"
                  label={t('ext.reports.reportTemplates.moveDown')}
                  disabled={index === value.length - 1}
                  onClick={() => move(index, 1)}
                >
                  <ArrowDown size={14} />
                </IconButton>
                <IconButton
                  size="compact"
                  variant="destructive"
                  label={t('ext.reports.reportTemplates.removeSection')}
                  onClick={() => onChange(value.filter((_, i) => i !== index))}
                >
                  <Trash2 size={14} />
                </IconButton>
              </div>
            </div>
            {keyProblem && <p className="text-xs text-danger">{keyProblem}</p>}
            <Textarea
              rows={2}
              value={section.guidance}
              maxLength={REPORT_TEMPLATE_LIMITS.guidance}
              placeholder={t('ext.reports.reportTemplates.guidancePlaceholder')}
              aria-label={t('ext.reports.reportTemplates.guidance')}
              onChange={(event) => update(index, { guidance: event.target.value })}
            />
          </div>
        );
      })}
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={value.length >= REPORT_TEMPLATE_LIMITS.sections}
        onClick={() =>
          onChange([...value, { key: nextKey(value), title: '', guidance: '', required: false, content: 'markdown' }])
        }
      >
        <Plus size={14} /> {t('ext.reports.reportTemplates.addSection')}
      </Button>
    </div>
  );
}
