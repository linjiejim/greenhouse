/**
 * Deliverable panel — the run's final product, rendered as prose plus the
 * one-stop delivery actions (copy / download / file into the knowledge base).
 *
 * The deliverable node's output_schema field names are planner-chosen, so the
 * dominant long string is treated as the report body and everything else is
 * kept (collapsed) as structured metadata rather than thrown away.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { BookPlus, ChevronDown, ChevronUp, Copy, Download } from '../../lib/icons';
import { splitWorkflowSummary } from '@greenhouse/types/workflow';
import { Markdown } from '../markdown';
import { toast } from '../ui';
import { useT } from '../../lib/i18n';
import { createKnowledgeDoc } from '../../lib/api/knowledge';

function download(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function slugifyFilename(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|]+/g, '-').trim();
  return `${cleaned || 'workflow'}.md`;
}

export function DeliverableView({
  summary,
  workflowName,
  taskInput,
}: {
  summary: Record<string, unknown>;
  workflowName: string;
  taskInput: string;
}) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const [saving, setSaving] = useState(false);
  const { body, rest } = useMemo(() => splitWorkflowSummary(summary), [summary]);
  const text = body || JSON.stringify(summary, null, 2);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast(t('workflow.copied'), 'success');
    } catch {
      toast(t('workflow.copyFailed'), 'error');
    }
  }, [text, t]);

  const handleSaveToKb = useCallback(async () => {
    if (saving) return;
    setSaving(true);
    try {
      const doc = await createKnowledgeDoc({
        title: workflowName,
        content_markdown: text,
        visibility: 'private',
        status: 'published',
        summary: taskInput.slice(0, 500),
      });
      toast(t('workflow.savedToKb'), 'success');
      window.open(`#/knowledge/doc/${doc.id}-${doc.slug}`, '_blank');
    } catch (err) {
      toast(err instanceof Error ? err.message : t('workflow.saveToKbFailed'), 'error');
    } finally {
      setSaving(false);
    }
  }, [saving, workflowName, text, taskInput, t]);

  return (
    <div className="rounded-md border border-success/30 bg-success-subtle/40 px-2.5 py-2">
      <div className="mb-1.5 flex items-center gap-2">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-success">{t('workflow.summary')}</div>
        <div className="ml-auto flex items-center gap-1">
          <ActionButton icon={<Copy size={11} />} label={t('workflow.copy')} onClick={handleCopy} />
          <ActionButton
            icon={<Download size={11} />}
            label={t('workflow.downloadMd')}
            onClick={() => download(slugifyFilename(workflowName), text)}
          />
          <ActionButton
            icon={<BookPlus size={11} />}
            label={t('workflow.saveToKb')}
            onClick={handleSaveToKb}
            disabled={saving}
          />
        </div>
      </div>

      <div className="relative">
        <div className={expanded ? '' : 'max-h-80 overflow-hidden'}>
          {body ? (
            <Markdown content={body} compact className="text-[12px]" />
          ) : (
            <pre className="whitespace-pre-wrap break-words text-[11px] leading-relaxed text-fg">{text}</pre>
          )}
        </div>
        {!expanded && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-success-subtle/80 to-transparent" />
        )}
      </div>

      <button
        onClick={() => setExpanded((v) => !v)}
        className="mt-1 flex items-center gap-1 text-[10px] font-medium text-fg-secondary hover:text-fg"
      >
        {expanded ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
        {expanded ? t('workflow.collapse') : t('workflow.expandFull')}
      </button>

      {Object.keys(rest).length > 0 && (
        <details className="mt-1.5">
          <summary className="cursor-pointer text-[10px] text-fg-faint hover:text-fg-secondary">
            {t('workflow.structuredOutput')}
          </summary>
          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-surface-raised px-2 py-1.5 text-[10px] text-fg-secondary">
            {JSON.stringify(rest, null, 2)}
          </pre>
        </details>
      )}
    </div>
  );
}

function ActionButton({
  icon,
  label,
  onClick,
  disabled,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={label}
      className="inline-flex items-center gap-1 rounded-md border border-edge bg-surface-raised px-1.5 py-0.5 text-[10px] text-fg-secondary transition-colors hover:bg-surface-muted hover:text-fg disabled:opacity-50"
    >
      {icon}
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}
