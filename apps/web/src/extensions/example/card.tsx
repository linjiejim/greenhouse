/** Chat card for `example_notes_query` results — replaces the generic trace row. */
import React from 'react';
import { StickyNote } from '../../lib/icons';
import { useT } from '../../lib/i18n';
import type { ExtensionToolCallView } from '../define';

export function ExampleNotesCard({ call }: { call: ExtensionToolCallView }) {
  const t = useT();
  const out = call.output as { count?: number; notes?: Array<{ id: number; body: string }> } | undefined;
  const notes = out?.notes ?? [];
  return (
    <div className="my-2 rounded-xl border border-edge bg-surface-raised p-3" data-testid="example-notes-card">
      <div className="mb-2 flex items-center gap-2 text-sm font-medium text-fg">
        <StickyNote size={14} className="text-primary-fg-strong" />
        <span>{t('ext.example.card.title')}</span>
        <span className="ml-auto text-xs text-fg-faint">{t('ext.example.card.count', { count: notes.length })}</span>
      </div>
      {notes.length === 0 ? (
        <p className="text-xs text-fg-faint">{t('ext.example.card.empty')}</p>
      ) : (
        <ul className="list-disc space-y-1 pl-4">
          {notes.map((n) => (
            <li key={n.id} className="truncate text-sm text-fg-secondary">
              {n.body}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
