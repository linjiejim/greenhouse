import type { RuntimeDatasetDraft, RuntimeDatasetPreview } from '@greenhouse/types/eval';
import type { RuntimeJsonValue } from '@greenhouse/types/runtime';
import { useEffect, useRef, useState } from 'react';
import { Button, Checkbox, Dialog, Input, Select, Spinner, Textarea, toast } from '../../components/ui';
import { createRuntimeDataset, previewRuntimeDataset } from '../../lib/api/runtime-dataset';
import { AlertTriangle, FlaskConical } from '../../lib/icons';
import { useT } from '../../lib/i18n';
import { RuntimePayloadPanel } from './payload-panel';

function captureKey(runId: string): string {
  const nonce = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `web:trace-dataset:${runId}:${nonce}`;
}

export function TraceDatasetDialog({ runId, open, onClose }: { runId: string; open: boolean; onClose: () => void }) {
  const t = useT();
  const [preview, setPreview] = useState<RuntimeDatasetPreview | null>(null);
  const [draft, setDraft] = useState<RuntimeDatasetDraft | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState(() => captureKey(runId));
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const submittingRef = useRef(false);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true);
    setError('');
    setPreview(null);
    setDraft(null);
    setIdempotencyKey(captureKey(runId));
    void previewRuntimeDataset(runId)
      .then((value) => {
        if (!active) return;
        setPreview(value);
        setDraft(value.draft);
      })
      .catch((cause) => {
        if (active) setError(cause instanceof Error ? cause.message : t('taskCenter.traceDataset.loadFailed'));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [open, runId, t]);

  const patchDraft = <K extends keyof RuntimeDatasetDraft>(key: K, value: RuntimeDatasetDraft[K]) => {
    setDraft((current) => (current ? { ...current, [key]: value } : current));
  };

  const submit = async () => {
    if (!draft || submittingRef.current || !draft.question.trim() || !draft.ground_truth.trim()) return;
    submittingRef.current = true;
    setSaving(true);
    try {
      const result = await createRuntimeDataset(runId, { idempotency_key: idempotencyKey, dataset: draft });
      toast(
        result.created ? t('taskCenter.traceDataset.created') : t('taskCenter.traceDataset.alreadyCreated'),
        'success',
      );
      onClose();
      window.location.hash = '#/administration/eval/datasets';
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : t('taskCenter.traceDataset.createFailed'), 'error');
    } finally {
      submittingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={saving ? () => undefined : onClose}
      title={t('taskCenter.traceDataset.title')}
      size="workspace"
    >
      {loading && (
        <div className="flex min-h-48 items-center justify-center">
          <Spinner className="h-6 w-6 text-fg-faint" />
        </div>
      )}
      {!loading && error && (
        <div className="rounded-lg border border-danger bg-danger-subtle px-3 py-2 text-sm text-danger">{error}</div>
      )}
      {!loading && preview && draft && (
        <div className="space-y-4">
          <div className="rounded-lg border border-edge bg-surface-muted p-3">
            <div className="flex items-start gap-2">
              <FlaskConical size={16} className="mt-0.5 flex-shrink-0 text-primary-fg" aria-hidden="true" />
              <div className="min-w-0 text-xs text-fg-secondary">
                <p className="font-semibold text-fg">{t('taskCenter.traceDataset.explicitOnly')}</p>
                <p className="mt-1 selectable break-all">
                  {preview.source.runtime_kind} · {preview.source.runtime_run_id}
                </p>
              </div>
            </div>
          </div>

          {preview.warnings.map((warning) => (
            <div
              key={warning.code}
              className="rounded-lg border border-warning bg-warning-subtle px-3 py-2 text-xs text-warning"
            >
              <div className="flex items-start gap-2">
                <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
                <div className="min-w-0">
                  <p>
                    {warning.code === 'sensitive_content'
                      ? t('taskCenter.traceDataset.sensitiveWarning')
                      : t('taskCenter.traceDataset.groundTruthWarning')}
                  </p>
                  {warning.paths.length > 0 && (
                    <p className="selectable mt-1 break-all font-mono text-[10px] opacity-80">
                      {warning.paths.join(' · ')}
                    </p>
                  )}
                </div>
              </div>
            </div>
          ))}

          <div className="grid gap-3 md:grid-cols-3">
            <label className="block text-xs font-medium text-fg-secondary">
              {t('eval.category')}
              <Input
                className="mt-1"
                value={draft.category}
                onChange={(event) => patchDraft('category', event.target.value)}
              />
            </label>
            <label className="block text-xs font-medium text-fg-secondary">
              {t('taskCenter.traceDataset.difficulty')}
              <Select
                className="mt-1"
                value={draft.difficulty}
                onChange={(event) => patchDraft('difficulty', event.target.value)}
              >
                <option value="easy">{t('eval.easy')}</option>
                <option value="medium">{t('eval.medium')}</option>
                <option value="hard">{t('eval.hard')}</option>
              </Select>
            </label>
            <label className="block text-xs font-medium text-fg-secondary">
              {t('taskCenter.traceDataset.language')}
              <Select
                className="mt-1"
                value={draft.language}
                onChange={(event) => patchDraft('language', event.target.value)}
              >
                <option value="en">{t('eval.english')}</option>
                <option value="zh">{t('eval.chinese')}</option>
              </Select>
            </label>
          </div>

          <label className="block text-xs font-medium text-fg-secondary">
            {t('eval.question')}
            <Textarea
              className="mt-1 min-h-24 resize-y"
              value={draft.question}
              onChange={(event) => patchDraft('question', event.target.value)}
            />
          </label>
          <label className="block text-xs font-medium text-fg-secondary">
            {t('eval.groundTruth')}
            <Textarea
              className="mt-1 min-h-32 resize-y"
              value={draft.ground_truth}
              onChange={(event) => patchDraft('ground_truth', event.target.value)}
            />
          </label>
          <label className="block text-xs font-medium text-fg-secondary">
            {t('eval.expectedBehavior')}
            <Textarea
              className="mt-1 min-h-20 resize-y"
              value={draft.expected_behavior}
              onChange={(event) => patchDraft('expected_behavior', event.target.value)}
            />
          </label>
          <label className="block text-xs font-medium text-fg-secondary">
            {t('eval.tagsCommaSeparated')}
            <Input
              className="mt-1"
              value={draft.tags.join(', ')}
              onChange={(event) =>
                patchDraft(
                  'tags',
                  event.target.value
                    .split(',')
                    .map((tag) => tag.trim())
                    .filter(Boolean),
                )
              }
            />
          </label>
          <label className="block text-xs font-medium text-fg-secondary">
            {t('eval.notes')}
            <Textarea
              className="mt-1 min-h-20 resize-y"
              value={draft.notes}
              onChange={(event) => patchDraft('notes', event.target.value)}
            />
          </label>
          <div className="flex flex-wrap gap-4">
            <Checkbox
              label={t('eval.negativeTest')}
              checked={draft.is_negative}
              onChange={(event) => patchDraft('is_negative', event.target.checked)}
            />
            <Checkbox
              label={t('taskCenter.traceDataset.enabled')}
              checked={draft.enabled}
              onChange={(event) => patchDraft('enabled', event.target.checked)}
            />
          </div>

          <RuntimePayloadPanel
            title={t('taskCenter.traceDataset.fullEvidence')}
            value={preview.evidence as unknown as RuntimeJsonValue}
          />

          <div className="flex flex-wrap justify-end gap-2 border-t border-edge pt-3">
            <Button variant="ghost" size="sm" onClick={onClose} disabled={saving}>
              {t('common.cancel')}
            </Button>
            <Button
              size="sm"
              onClick={() => void submit()}
              disabled={saving || !draft.question.trim() || !draft.ground_truth.trim()}
            >
              {saving ? t('common.saving') : t('taskCenter.traceDataset.create')}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
