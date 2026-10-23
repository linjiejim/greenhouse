/**
 * Report templates — SkillHub tab (`#/skillhub?tab=reports`, v1.7).
 *
 * The team's required shape for reports and decks: sections with guidance,
 * cover fields, output formats, rendered in the workspace brand. Members'
 * agents read them over MCP (`report_templates`) and render with
 * `report_render`; the output lands in Files.
 *
 * Same rights as publishing a skill: any member may publish a team template
 * or keep a personal draft; a team template is changed by its owner or a
 * super (`can_edit` comes from the server). Preview renders sample content
 * into a PDF — for a saved template, or for the form as it stands.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  REPORT_FORMATS_BY_KIND,
  type ReportFormat,
  type ReportKind,
  type ReportTemplateCoverField,
  type ReportTemplateDefinition,
  type ReportTemplateSection,
  type ReportTemplateView,
  type ReportTemplateVisibility,
} from '@greenhouse/types/reports';
import { defineCrud, CrudPage, type CrudDataSource } from '../settings/crud';
import { Button, EmptyState, Tag, toast } from '../../components/ui';
import { MediaPreviewDialog } from '../../components/media-preview-dialog';
import { CoverFieldsField, FormatsField, SectionsField } from '../../components/skillhub/report-template-fields';
import { Eye, FileText, Plus } from '../../lib/icons';
import { useI18n } from '../../lib/i18n';
import {
  createReportTemplate,
  deleteReportTemplate,
  fetchReportTemplates,
  previewReportTemplate,
  updateReportTemplate,
  type ReportTemplateInput,
} from '../../lib/api/report-templates';

function kindOf(data: Record<string, unknown>): ReportKind {
  return data.kind === 'presentation' ? 'presentation' : 'report';
}

/** The ticked formats the form's kind allows — empty when none are, never a silent default. */
function pickedFormats(data: Record<string, unknown>): ReportFormat[] {
  const picked = Array.isArray(data.formats) ? (data.formats as ReportFormat[]) : [];
  return REPORT_FORMATS_BY_KIND[kindOf(data)].filter((format) => picked.includes(format));
}

/**
 * The form's values as a template definition. Formats are only narrowed to
 * the kind: a cleared selection stays cleared and is refused by validation
 * (defaults belong to a new form's initial values, not to saving).
 */
export function toInput(data: Record<string, unknown>): ReportTemplateInput {
  const kind = kindOf(data);
  const formats = pickedFormats(data);
  return {
    name: String(data.name ?? '').trim(),
    description: String(data.description ?? '').trim(),
    kind,
    formats,
    visibility: (data.visibility === 'personal' ? 'personal' : 'team') as ReportTemplateVisibility,
    cover_fields: Array.isArray(data.cover_fields) ? (data.cover_fields as ReportTemplateCoverField[]) : [],
    sections: Array.isArray(data.sections) ? (data.sections as ReportTemplateSection[]) : [],
  };
}

function usePdfPreview() {
  const { t, locale } = useI18n();
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url]);
  const open = useCallback(
    async (source: { template_id: string } | { template: ReportTemplateDefinition }) => {
      setBusy(true);
      try {
        const blob = await previewReportTemplate(source, locale);
        setUrl(URL.createObjectURL(blob));
      } catch (error) {
        toast(error instanceof Error ? error.message : t('reportTemplates.previewFailed'), 'error');
      } finally {
        setBusy(false);
      }
    },
    [locale, t],
  );
  const dialog = (
    <MediaPreviewDialog
      open={url !== null}
      files={url ? [{ src: url, type: 'pdf', name: t('reportTemplates.previewTitle') }] : []}
      onClose={() => setUrl(null)}
    />
  );
  return { open, busy, dialog };
}

export function ReportTemplatesPanel() {
  const { t } = useI18n();
  const { open: openPreview, busy: previewBusy, dialog: previewDialog } = usePdfPreview();

  const dataSource = useMemo<CrudDataSource<ReportTemplateView>>(
    () => ({
      async list(params) {
        const all = await fetchReportTemplates();
        const skip = params.skip ?? 0;
        return { items: all.slice(skip, skip + (params.limit ?? 50)), total: all.length };
      },
      create: (data) => createReportTemplate(toInput(data)),
      update: (id, data) => updateReportTemplate(String(id), toInput(data)),
      remove: (id) => deleteReportTemplate(String(id)),
    }),
    [],
  );

  const schema = useMemo(
    () =>
      defineCrud<ReportTemplateView>({
        name: t('reportTemplates.name'),
        dataSource,
        testId: 'report-templates',
        pageSize: 50,
        storageKey: 'skillhub-report-templates',
        formSize: 'workspace',
        formTitle: (mode) => (mode === 'add' ? t('reportTemplates.newTemplate') : t('reportTemplates.editTemplate')),
        columns: [
          {
            key: 'name',
            label: t('reportTemplates.fieldName'),
            type: 'custom',
            render: (row) => (
              <div className="min-w-0">
                <div className="truncate font-medium text-fg" title={row.name}>
                  {row.name}
                </div>
                {row.description && (
                  <div className="truncate text-xs text-fg-muted" title={row.description}>
                    {row.description}
                  </div>
                )}
              </div>
            ),
          },
          {
            key: 'kind',
            label: t('reportTemplates.fieldKind'),
            type: 'custom',
            width: '7rem',
            render: (row) => <Tag tone="primary">{t(`reportTemplates.kind.${row.kind}`)}</Tag>,
          },
          {
            key: 'formats',
            label: t('reportTemplates.fieldFormats'),
            type: 'custom',
            width: '8rem',
            render: (row) => (
              <span className="text-xs uppercase text-fg-muted whitespace-nowrap">{row.formats.join(' · ')}</span>
            ),
          },
          {
            key: 'sections',
            label: t('reportTemplates.fieldSections'),
            type: 'custom',
            width: '8rem',
            render: (row) => (
              <span className="text-xs text-fg-muted whitespace-nowrap">
                {t('reportTemplates.sectionCount', {
                  count: row.sections.length,
                  required: row.sections.filter((section) => section.required).length,
                })}
              </span>
            ),
          },
          {
            key: 'visibility',
            label: t('reportTemplates.fieldVisibility'),
            type: 'custom',
            width: '6rem',
            render: (row) =>
              row.visibility === 'team' ? (
                <Tag tone="success">{t('reportTemplates.visibility.team')}</Tag>
              ) : (
                <Tag>{t('reportTemplates.visibility.personal')}</Tag>
              ),
          },
          {
            key: 'owner_name',
            label: t('reportTemplates.fieldOwner'),
            type: 'custom',
            width: '8rem',
            render: (row) => (
              <span className="text-xs text-fg-muted">
                {row.is_default ? t('reportTemplates.builtIn') : (row.owner_name ?? '—')}
              </span>
            ),
          },
        ],
        formFields: [
          { key: 'name', label: t('reportTemplates.fieldName'), type: 'text', required: true, width: 2 },
          {
            key: 'kind',
            label: t('reportTemplates.fieldKind'),
            type: 'select',
            width: 1,
            defaultValue: 'report',
            options: [
              { value: 'report', label: t('reportTemplates.kind.report') },
              { value: 'presentation', label: t('reportTemplates.kind.presentation') },
            ],
          },
          {
            key: 'visibility',
            label: t('reportTemplates.fieldVisibility'),
            type: 'select',
            width: 1,
            defaultValue: 'team',
            help: t('reportTemplates.visibilityHelp'),
            options: [
              { value: 'team', label: t('reportTemplates.visibility.team') },
              { value: 'personal', label: t('reportTemplates.visibility.personal') },
            ],
          },
          { key: 'description', label: t('reportTemplates.fieldDescription'), type: 'textarea', rows: 2 },
          {
            key: 'formats',
            label: t('reportTemplates.fieldFormats'),
            type: 'custom',
            defaultValue: ['pdf', 'docx'],
            help: t('reportTemplates.formatsHelp'),
            rules: [
              {
                validate: (_value, form) =>
                  pickedFormats(form).length === 0 ? t('reportTemplates.formatsRequired') : null,
              },
            ],
            render: ({ value, onChange, form }) => (
              <FormatsField
                kind={form.kind === 'presentation' ? 'presentation' : 'report'}
                value={Array.isArray(value) ? (value as ReportFormat[]) : []}
                onChange={onChange}
              />
            ),
          },
          {
            key: 'cover_fields',
            label: t('reportTemplates.fieldCover'),
            type: 'custom',
            defaultValue: [{ key: 'title', required: true }],
            help: t('reportTemplates.coverHelp'),
            render: ({ value, onChange }) => (
              <CoverFieldsField
                value={Array.isArray(value) ? (value as ReportTemplateCoverField[]) : []}
                onChange={onChange}
              />
            ),
          },
          {
            key: 'sections',
            label: t('reportTemplates.fieldSections'),
            type: 'custom',
            required: true,
            defaultValue: [],
            help: t('reportTemplates.sectionsHelp'),
            render: ({ value, onChange, form }) => (
              <div className="space-y-3">
                <SectionsField
                  value={Array.isArray(value) ? (value as ReportTemplateSection[]) : []}
                  onChange={onChange}
                />
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={previewBusy}
                  onClick={() => {
                    // A preview always renders a PDF, whatever is ticked.
                    const draft = toInput(form);
                    void openPreview({
                      template: { ...draft, formats: draft.formats.length ? draft.formats : ['pdf'] },
                    });
                  }}
                  data-testid="report-templates-preview-form"
                >
                  <Eye size={14} /> {t('reportTemplates.previewDraft')}
                </Button>
              </div>
            ),
          },
        ],
        access: {
          canView: false,
          canAdd: true,
          canEdit: true,
          canDelete: true,
          canEditRow: (row) => Boolean((row as unknown as ReportTemplateView).can_edit),
          canDeleteRow: (row) => Boolean((row as unknown as ReportTemplateView).can_edit),
        },
        tableActions: [
          {
            key: 'preview',
            label: t('reportTemplates.preview'),
            icon: Eye,
            onClick: (row) => void openPreview({ template_id: row.id }),
          },
        ],
        deleteConfirm: (row) => ({
          title: t('reportTemplates.deleteTitle', { name: row.name }),
          description: t('reportTemplates.deleteDescription'),
        }),
        slots: {
          toolbar: (ctx) => (
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex-1" />
              <span className="whitespace-nowrap text-xs text-fg-muted">
                {t('reportTemplates.count', { count: ctx.total })}
              </span>
              <Button size="sm" onClick={ctx.openCreate} data-testid="report-templates-new">
                <Plus size={14} /> {t('reportTemplates.newTemplate')}
              </Button>
            </div>
          ),
          empty: (
            <EmptyState
              icon={FileText}
              title={t('reportTemplates.emptyTitle')}
              description={t('reportTemplates.emptyDescription')}
            />
          ),
        },
      }),
    [t, dataSource, openPreview, previewBusy],
  );

  return (
    <>
      <CrudPage schema={schema} />
      {previewDialog}
    </>
  );
}
