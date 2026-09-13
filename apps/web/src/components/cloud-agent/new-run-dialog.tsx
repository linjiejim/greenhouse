/**
 * Mission — creation dialog (prompt + optional title + model).
 *
 * POST /api/missions/runs. A 503 means the runtime is switched off on this
 * deployment (CLOUD_AGENT_ENABLED unset) — surfaced as an inline warning state,
 * not a generic error toast.
 */

import React, { useRef, useState } from 'react';
import { Button, Dialog, Input, Select, Textarea, toast } from '../ui';
import { CircleAlert, Paperclip } from '../../lib/icons';
import { useT } from '../../lib/i18n';
import { CloudAgentDisabledError, createCloudAgentRun, MAX_CLOUD_AGENT_ATTACHMENTS } from '../../lib/api/cloud-agent';
import {
  acceptCloudAttachments,
  AttachmentChips,
  uploadPendingCloudAttachments,
  type PendingCloudAttachment,
} from './attachments';
import { useMissionModels } from './shared';

interface NewRunDialogProps {
  open: boolean;
  onClose: () => void;
  /** Called with the new run id after a successful launch. */
  onCreated: (runId: string) => void;
}

export function NewRunDialog({ open, onClose, onCreated }: NewRunDialogProps) {
  const t = useT();
  // Chat model catalog — the mission vocabulary is the same; the hardcoded
  // kimi-k3/pro pair predates the relay accepting any registry model.
  const models = useMissionModels();
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  // Empty means "let the deployment choose". Keeping a registry id here used
  // to override CLOUD_AGENT_DEFAULT_MODEL on every standalone launch.
  const [model, setModel] = useState('');
  const [budget, setBudget] = useState<'light' | 'standard' | 'deep'>('standard');
  const [attachments, setAttachments] = useState<PendingCloudAttachment[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [runtimeDisabled, setRuntimeDisabled] = useState(false);
  const attachmentInputRef = useRef<HTMLInputElement>(null);

  const reset = () => {
    setTitle('');
    setPrompt('');
    setModel('');
    setBudget('standard');
    setAttachments([]);
    setError('');
    setRuntimeDisabled(false);
  };

  const handleFileSelect = (files: FileList) => {
    const { next, tooLarge, overflow } = acceptCloudAttachments(attachments, Array.from(files));
    if (tooLarge.length > 0) toast(t('cloudAgent.attachmentTooLarge', { name: tooLarge[0].name }), 'error');
    if (overflow > 0) toast(t('cloudAgent.attachmentLimitReached', { count: MAX_CLOUD_AGENT_ATTACHMENTS }), 'info');
    if (next !== attachments) setAttachments(next);
  };

  const handleClose = () => {
    if (submitting) return;
    reset();
    onClose();
  };

  const handleSubmit = async () => {
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt) {
      setError(t('cloudAgent.promptRequired'));
      return;
    }
    setSubmitting(true);
    setError('');
    setRuntimeDisabled(false);
    try {
      // Upload input files first — a failure keeps the chips (with the error)
      // so the user can retry the launch or remove the offending file.
      let attachmentRefs: Array<{ key: string; name: string }> = [];
      if (attachments.length > 0) {
        const refs = await uploadPendingCloudAttachments(attachments, setAttachments);
        if (!refs) {
          setError(t('cloudAgent.attachmentUploadFailed'));
          setSubmitting(false);
          return;
        }
        attachmentRefs = refs;
      }
      const run = await createCloudAgentRun({
        prompt: trimmedPrompt,
        ...(model ? { model } : {}),
        ...(title.trim() ? { title: title.trim() } : {}),
        budget,
        ...(attachmentRefs.length > 0 ? { attachments: attachmentRefs } : {}),
      });
      toast(t('cloudAgent.taskStarted'), 'success');
      reset();
      onCreated(run.id);
    } catch (err) {
      if (err instanceof CloudAgentDisabledError) {
        setRuntimeDisabled(true);
      } else {
        setError(err instanceof Error ? err.message : t('cloudAgent.createFailed'));
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onClose={handleClose} title={t('cloudAgent.createTitle')} size="lg">
      <div className="space-y-4">
        {runtimeDisabled && (
          <div className="flex items-start gap-2 rounded-md border border-warning bg-warning-subtle px-3 py-2.5">
            <CircleAlert size={16} className="mt-0.5 flex-shrink-0 text-warning" />
            <div className="text-xs text-warning">{t('cloudAgent.runtimeDisabled')}</div>
          </div>
        )}

        <div>
          <label className="mb-1 block text-[11px] font-medium text-fg-faint">{t('cloudAgent.promptLabel')}</label>
          <Textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={t('cloudAgent.promptPlaceholder')}
            rows={6}
            autoFocus
            disabled={submitting}
          />
        </div>

        {/* Input files (any type) — materialized into the sandbox ./inputs/ */}
        <div className="space-y-2">
          <input
            ref={attachmentInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files) handleFileSelect(e.target.files);
              e.target.value = '';
            }}
          />
          <button
            onClick={() => attachmentInputRef.current?.click()}
            disabled={submitting || attachments.length >= MAX_CLOUD_AGENT_ATTACHMENTS}
            className="inline-flex items-center gap-1.5 rounded-lg border border-edge px-2.5 py-1.5 text-xs text-fg-secondary transition-colors hover:bg-surface-muted hover:text-fg disabled:opacity-40"
          >
            <Paperclip size={13} />
            {t('cloudAgent.attach', { count: MAX_CLOUD_AGENT_ATTACHMENTS })}
          </button>
          <AttachmentChips
            attachments={attachments}
            onRemove={(i) => setAttachments((prev) => prev.filter((_, idx) => idx !== i))}
          />
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div>
            <label className="mb-1 block text-[11px] font-medium text-fg-faint">{t('cloudAgent.titleLabel')}</label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t('cloudAgent.titlePlaceholder')}
              disabled={submitting}
            />
          </div>
          <div>
            <label className="mb-1 block text-[11px] font-medium text-fg-faint">{t('cloudAgent.modelLabel')}</label>
            <Select value={model} onChange={(e) => setModel(e.target.value)} disabled={submitting}>
              <option value="">{t('cloudAgent.dispatchDefaultModel')}</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name || m.id}
                </option>
              ))}
              {model && !models.some((m) => m.id === model) && <option value={model}>{model}</option>}
            </Select>
          </div>
          <div>
            <label className="mb-1 block text-[11px] font-medium text-fg-faint">{t('cloudAgent.budgetLabel')}</label>
            <Select
              value={budget}
              onChange={(event) => setBudget(event.target.value as 'light' | 'standard' | 'deep')}
              disabled={submitting}
            >
              <option value="light">{t('cloudAgent.budgetLight')}</option>
              <option value="standard">{t('cloudAgent.budgetStandard')}</option>
              <option value="deep">{t('cloudAgent.budgetDeep')}</option>
            </Select>
            <div className="mt-1 text-[10px] leading-4 text-fg-faint">
              {budget === 'light'
                ? t('cloudAgent.budgetLightHint')
                : budget === 'deep'
                  ? t('cloudAgent.budgetDeepHint')
                  : t('cloudAgent.budgetStandardHint')}
            </div>
          </div>
        </div>

        {error && (
          <div className="rounded-md border border-danger bg-danger-subtle px-3 py-2 text-xs text-danger">{error}</div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="outline" onClick={handleClose} disabled={submitting}>
            {t('common.cancel')}
          </Button>
          <Button onClick={handleSubmit} disabled={submitting || !prompt.trim()}>
            {submitting ? t('cloudAgent.creating') : t('cloudAgent.create')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
