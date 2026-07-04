/**
 * CrudDetail — read-only record view in a right Drawer. Shows detailTabs when
 * declared, otherwise a label/value grid built from the columns (including
 * columns marked hidden, which are detail-only). Exported standalone.
 */

import React, { useState } from 'react';
import { Button, Drawer } from '@greenhouse/ui/components/ui';
import { Pencil, X } from '@greenhouse/ui/lib/icons';
import { useT } from '@greenhouse/ui/lib/i18n';

import type { ColumnDef, ResolvedCrudSchema } from './schema.js';
import { renderCell } from './columns.js';
import { tr } from './util.js';

export interface CrudDetailProps<TRow> {
  schema: ResolvedCrudSchema<TRow>;
  row: TRow;
  onClose: () => void;
  onEdit?: () => void;
}

export function CrudDetail<TRow>({ schema, row, onClose, onEdit }: CrudDetailProps<TRow>) {
  const t = useT();
  const [tab, setTab] = useState<string>(schema.detailTabs?.[0]?.key ?? '');

  const fieldGrid = (cols: ColumnDef<TRow>[]) => (
    <div className="grid grid-cols-2 gap-x-4 gap-y-3">
      {cols.map((col) => (
        <div key={col.key} className="min-w-0">
          <div className="text-[11px] uppercase tracking-wide text-fg-faint mb-0.5">{tr(t, col.label)}</div>
          <div className="text-sm text-fg break-words">{renderCell(col, row)}</div>
        </div>
      ))}
    </div>
  );

  const activeTab = schema.detailTabs?.find((tb) => tb.key === tab) ?? schema.detailTabs?.[0];

  return (
    <Drawer open onClose={onClose} side="right" width={520}>
      <div className="flex flex-col h-full">
        <div className="flex items-center justify-between px-4 py-3 border-b border-edge">
          <h2 className="text-base font-semibold text-fg">{tr(t, schema.name)}</h2>
          <div className="flex items-center gap-1">
            {onEdit && schema.access.canEdit && (
              <Button size="sm" variant="ghost" onClick={onEdit}>
                <Pencil size={14} className="mr-1" />
                {t('crud.edit')}
              </Button>
            )}
            <button onClick={onClose} className="p-1.5 text-fg-muted hover:text-fg rounded" title={t('crud.close')}>
              <X size={16} />
            </button>
          </div>
        </div>

        {schema.detailTabs && schema.detailTabs.length > 0 && (
          <div className="flex gap-1 px-4 border-b border-edge">
            {schema.detailTabs.map((tb) => (
              <button
                key={tb.key}
                onClick={() => setTab(tb.key)}
                className={`px-3 py-2 text-sm border-b-2 -mb-px transition-colors ${
                  (activeTab?.key ?? '') === tb.key
                    ? 'border-primary-500 text-fg'
                    : 'border-transparent text-fg-muted hover:text-fg'
                }`}
              >
                {tr(t, tb.label)}
              </button>
            ))}
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-4">
          {activeTab
            ? activeTab.kind === 'custom'
              ? activeTab.render(row)
              : fieldGrid(
                  activeTab.fields
                    ? schema.columns.filter((c) => (activeTab.fields as string[]).includes(c.key))
                    : schema.columns,
                )
            : fieldGrid(schema.columns)}
        </div>
      </div>
    </Drawer>
  );
}
