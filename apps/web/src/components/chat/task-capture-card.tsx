/**
 * The confirm card for a `task_capture` draft.
 *
 * The tool wrote nothing; this card's Create button is the only thing that
 * saves a Task. Every field is editable here because the model distilled a
 * conversation it can only partly judge — the person who ran the flow knows
 * whether "last month" should have been a variable.
 *
 * The stable message-position action id is claimed by the server before the
 * Task is created. Its durable receipt restores the compact success/failure
 * state after refresh, and the Task row carries the same id as a recovery key.
 */

import React, { useEffect, useState } from 'react';
import { Bookmark, Check } from 'lucide-react';
import type { TaskVariable } from '@greenhouse/types/tasks';
import { Button, Input, Textarea, toast } from '../ui';
import { getToolIcon } from '../../lib/icons';
import { useT } from '../../lib/i18n';
import { createPrompt } from '../../lib/api/prompts';
import { useArtifactReceipt } from '../../hooks/use-artifact-receipt';
import { ArtifactCard, ArtifactCardActions } from './artifact-card';

export interface TaskCaptureData {
  title: string;
  description?: string;
  content: string;
  variables: TaskVariable[];
  expected_tools: string[];
  source_session_id: string;
}

export function TaskCaptureCard({
  data,
  actionId,
  sessionId,
}: {
  data: TaskCaptureData;
  actionId?: string;
  sessionId?: string;
}) {
  const t = useT();
  const [title, setTitle] = useState(data.title);
  const [description, setDescription] = useState(data.description ?? '');
  const [content, setContent] = useState(data.content);
  const [saving, setSaving] = useState(false);
  const [createdId, setCreatedId] = useState<number | null>(null);
  const [open, setOpen] = useState(true);
  const { receipt, loading: receiptLoading, refresh: refreshReceipt } = useArtifactReceipt(actionId);

  useEffect(() => {
    if (receipt?.status !== 'succeeded' || !receipt.result || typeof receipt.result !== 'object') return;
    const id = (receipt.result as { id?: unknown }).id;
    if (typeof id === 'number') {
      setCreatedId(id);
      setOpen(false);
    }
  }, [receipt]);

  const save = async () => {
    if (!actionId || !sessionId || saving || createdId !== null) return;
    setSaving(true);
    try {
      const created = await createPrompt({
        title: title.trim(),
        content: content.trim(),
        description: description.trim() || undefined,
        // Variables are not editable inline: they must stay in step with the
        // `{{placeholders}}` in the body, and the server rejects a mismatch.
        // Editing them is what the Tasks page is for.
        variables: data.variables,
        expected_tools: data.expected_tools,
        source_session_id: data.source_session_id,
        created_via: 'capture',
        artifact_action_id: actionId,
        artifact_session_id: sessionId,
      });
      setCreatedId(created.id);
      setOpen(false);
      await refreshReceipt();
      toast(t('tasks.created'), 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : t('tasks.createFailed'), 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <ArtifactCard
      icon={<Bookmark size={14} />}
      title={t('tasks.capturedTitle')}
      meta={data.title}
      status={
        receiptLoading
          ? { label: t('common.loading'), busy: true }
          : saving || receipt?.status === 'processing'
            ? { label: t('tasks.creating'), tone: 'info', busy: true }
            : receipt?.status === 'failed'
              ? { label: t('common.failed'), tone: 'danger' }
              : createdId !== null
                ? { label: t('tasks.created'), tone: 'success' }
                : { label: t('tasks.reviewStatus'), tone: 'primary' }
      }
      collapsed={!open}
      onToggle={createdId !== null || receipt?.status === 'failed' ? () => setOpen((value) => !value) : undefined}
      tone={receipt?.status === 'failed' ? 'danger' : createdId !== null ? 'success' : 'neutral'}
      footer={
        <ArtifactCardActions hint={receipt?.status === 'failed' ? receipt.error : t('tasks.capturedHint')}>
          {createdId === null ? (
            <Button
              size="sm"
              disabled={
                saving ||
                receiptLoading ||
                receipt?.status === 'processing' ||
                !title.trim() ||
                !content.trim() ||
                !actionId ||
                !sessionId
              }
              onClick={save}
            >
              <Bookmark size={13} className="mr-1.5" />
              {saving ? t('tasks.creating') : t('tasks.create')}
            </Button>
          ) : (
            <span className="inline-flex items-center gap-1 text-xs text-success">
              <Check size={13} />
              {t('tasks.created')}
            </span>
          )}
        </ArtifactCardActions>
      }
    >
      <div className="space-y-2.5">
        {createdId === null && <p className="text-[11px] text-fg-faint">{t('tasks.capturedHint')}</p>}

        <label className="block">
          <span className="mb-0.5 block text-[10px] text-fg-muted">{t('tasks.fieldTitle')}</span>
          <Input size="sm" value={title} onChange={(e) => setTitle(e.target.value)} disabled={createdId !== null} />
        </label>

        <label className="block">
          <span className="mb-0.5 block text-[10px] text-fg-muted">{t('tasks.fieldDescription')}</span>
          <Input
            size="sm"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            disabled={createdId !== null}
          />
        </label>

        <label className="block">
          <span className="mb-0.5 block text-[10px] text-fg-muted">{t('tasks.fieldContent')}</span>
          <Textarea
            rows={7}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            disabled={createdId !== null}
            className="text-xs"
          />
        </label>

        {data.variables.length > 0 && (
          <div>
            <span className="mb-1 block text-[10px] text-fg-muted">{t('tasks.variables')}</span>
            <div className="flex flex-wrap gap-1">
              {data.variables.map((variable) => (
                <span
                  key={variable.key}
                  title={variable.example || undefined}
                  className="rounded border border-edge bg-surface-muted px-1.5 py-0.5 text-[10px] text-fg-secondary"
                >
                  {`{{${variable.key}}}`} · {variable.label}
                  {variable.required && <span className="ml-0.5 text-danger">*</span>}
                </span>
              ))}
            </div>
          </div>
        )}

        {data.expected_tools.length > 0 && (
          <div>
            {/* Derived from what this conversation really called, so it is a
                capability report rather than a claim. */}
            <span className="mb-1 block text-[10px] text-fg-muted">{t('tasks.usesTools')}</span>
            <div className="flex flex-wrap gap-1">
              {data.expected_tools.map((tool) => {
                const Icon = getToolIcon(tool);
                return (
                  <span
                    key={tool}
                    className="inline-flex items-center gap-1 rounded border border-edge bg-surface-muted px-1.5 py-0.5 text-[10px] text-fg-secondary"
                  >
                    <Icon size={10} />
                    {tool}
                  </span>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </ArtifactCard>
  );
}
