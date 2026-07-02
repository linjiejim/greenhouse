/**
 * UpdatePageResultCard — rich card display for update_page tool results.
 * Shows field-level diffs with word-level highlighting.
 */

import React, { useState } from 'react';
import { Badge } from '../ui';
import { renderDiffWords } from '../../lib/diff-words';
import { computeLineDiffWithWords } from '../../lib/wiki-diff';
import { CheckCircle } from '../../lib/icons';

// ─── Component ───────────────────────────────────────────

export function UpdatePageResultCard({ output }: { output: Record<string, unknown> }) {
  const changes = (output.changes as Array<{ field: string; before: string; after: string }>) || [];
  const [expanded, setExpanded] = useState<string | null>(changes.length > 0 ? changes[0].field : null);

  return (
    <div className="border border-success rounded-lg overflow-hidden bg-success-subtle/50">
      <div className="px-3 py-2 bg-surface-raised border-b border-success flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm">
            <CheckCircle size={14} />
          </span>
          <span className="text-xs font-semibold text-fg-secondary">Page Updated</span>
          <Badge variant="success">applied</Badge>
        </div>
        <span className="text-[10px] text-fg-faint">
          Changelog #{output.changelog_id as number} · {changes.length} field(s)
        </span>
      </div>
      {!!output.reason && (
        <div className="px-3 py-1.5 text-[11px] text-fg-muted border-b border-emerald-100">
          Reason: {output.reason as string}
        </div>
      )}
      <div className="divide-y divide-emerald-100">
        {changes.map((ch, i) => (
          <div key={i} className="px-3 py-1.5">
            <button
              className="w-full text-left flex items-center justify-between"
              onClick={() => setExpanded(expanded === ch.field ? null : ch.field)}
            >
              <div className="flex items-center gap-2">
                <Badge variant="secondary">{ch.field}</Badge>
                <DiffStats before={ch.before} after={ch.after} />
              </div>
              <span className="text-xs text-fg-faint">{expanded === ch.field ? '▲' : '▼'}</span>
            </button>
            {expanded === ch.field && (
              <div className="mt-1.5">
                <InlineWordDiff before={ch.before} after={ch.after} />
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────

function DiffStats({ before, after }: { before: string; after: string }) {
  const bLines = (before || '').split('\n').length;
  const aLines = (after || '').split('\n').length;
  const added = Math.max(0, aLines - bLines);
  const removed = Math.max(0, bLines - aLines);
  return (
    <span className="text-[10px] text-fg-faint">
      {added > 0 && <span className="text-success">+{added}</span>}
      {added > 0 && removed > 0 && ' '}
      {removed > 0 && <span className="text-danger">-{removed}</span>}
      {added === 0 && removed === 0 && <span>modified</span>}
    </span>
  );
}

function InlineWordDiff({ before, after }: { before: string; after: string }) {
  const diffLines = computeLineDiffWithWords(before || '', after || '', 300);

  return (
    <div className="rounded border border-edge overflow-auto max-h-64 text-[11px] font-mono leading-relaxed">
      {diffLines.map((line, i) => (
        <div
          key={i}
          className={`px-2 py-0.5 ${line.type === 'add' ? 'bg-success-subtle' : line.type === 'remove' ? 'bg-danger-subtle' : ''}`}
        >
          <span className="inline-block w-4 text-right mr-2 text-fg-faint select-none text-[10px]">
            {line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' '}
          </span>
          {line.type === 'same' ? (
            <span className="text-fg-secondary">{line.text}</span>
          ) : line.type === 'remove' ? (
            <span className="text-danger">{line.words ? renderDiffWords(line.words, 'remove') : line.text}</span>
          ) : (
            <span className="text-success-fg">{line.words ? renderDiffWords(line.words, 'add') : line.text}</span>
          )}
        </div>
      ))}
    </div>
  );
}
