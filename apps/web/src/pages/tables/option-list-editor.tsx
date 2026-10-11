/**
 * The options of a single / multi select, one row per option. Each row carries
 * the stored option it edits (`./option-list.ts`), so renaming, reordering and
 * removing never shift ids between options — records keep their values. Enter
 * adds a row below; pasting several lines adds one row per line.
 */

import { useEffect, useRef, useState } from 'react';
import { Button, IconButton, Input } from '../../components/ui';
import { ChevronDown, ChevronUp, Plus, X } from '../../lib/icons';
import { useT } from '../../lib/i18n';
import { moveRow, newOptionRow, type OptionRow } from './option-list';

export function OptionListEditor({ rows, onChange }: { rows: OptionRow[]; onChange: (rows: OptionRow[]) => void }) {
  const t = useT();
  const inputs = useRef(new Map<string, HTMLInputElement>());
  const [focusKey, setFocusKey] = useState<string | null>(null);

  useEffect(() => {
    if (!focusKey) return;
    inputs.current.get(focusKey)?.focus();
    setFocusKey(null);
  }, [focusKey, rows]);

  const insertAfter = (index: number, labels: string[] = ['']) => {
    const added = labels.map((label) => newOptionRow(label));
    onChange([...rows.slice(0, index + 1), ...added, ...rows.slice(index + 1)]);
    setFocusKey(added[added.length - 1]!.key);
  };

  const update = (index: number, label: string) =>
    onChange(rows.map((row, at) => (at === index ? { ...row, label } : row)));

  return (
    <div className="space-y-1.5" data-testid="option-list-editor">
      {rows.map((row, index) => {
        const name = row.label.trim() || t('tables.fieldOptions.label', { index: index + 1 });
        return (
          <div key={row.key} className="flex items-center gap-1" data-testid="option-row">
            <Input
              size="sm"
              ref={(element: HTMLInputElement | null) => {
                if (element) inputs.current.set(row.key, element);
                else inputs.current.delete(row.key);
              }}
              value={row.label}
              aria-label={t('tables.fieldOptions.label', { index: index + 1 })}
              onChange={(event) => update(index, event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  insertAfter(index);
                }
              }}
              onPaste={(event) => {
                const lines = event.clipboardData
                  .getData('text')
                  .split(/\r?\n/)
                  .map((line) => line.trim())
                  .filter(Boolean);
                if (lines.length < 2) return;
                event.preventDefault();
                // The first line fills this row when it is empty; the rest follow it.
                if (!row.label.trim()) {
                  const [first, ...rest] = lines;
                  const filled = rows.map((entry, at) => (at === index ? { ...entry, label: first! } : entry));
                  const added = rest.map((label) => newOptionRow(label));
                  onChange([...filled.slice(0, index + 1), ...added, ...filled.slice(index + 1)]);
                } else {
                  insertAfter(index, lines);
                }
              }}
              className="flex-1"
            />
            <IconButton
              size="compact"
              label={t('tables.fieldOptions.moveUp', { name })}
              disabled={index === 0}
              onClick={() => onChange(moveRow(rows, index, -1))}
            >
              <ChevronUp size={13} />
            </IconButton>
            <IconButton
              size="compact"
              label={t('tables.fieldOptions.moveDown', { name })}
              disabled={index === rows.length - 1}
              onClick={() => onChange(moveRow(rows, index, 1))}
            >
              <ChevronDown size={13} />
            </IconButton>
            <IconButton
              size="compact"
              variant="destructive"
              label={t('tables.fieldOptions.remove', { name })}
              onClick={() => onChange(rows.filter((_, at) => at !== index))}
            >
              <X size={13} />
            </IconButton>
          </div>
        );
      })}
      <Button type="button" variant="outline" size="sm" onClick={() => insertAfter(rows.length - 1)} className="gap-1">
        <Plus size={12} />
        {t('tables.fieldOptions.add')}
      </Button>
    </div>
  );
}
