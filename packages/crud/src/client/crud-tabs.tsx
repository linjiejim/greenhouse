/**
 * CrudTabs — a thin wrapper that puts several `defineCrud` schemas behind an
 * underline tab bar, for admin surfaces that manage multiple related entities
 * (e.g. an LLM gateway's upstreams / models / keys). Each tab renders an
 * independent <CrudPage/>; switching tabs remounts so per-page state resets.
 *
 * Cross-tab data dependencies (tab B's form needs tab A's rows) stay the schema
 * author's concern — pass a shared reload signal via `onEntityChange` and rebuild
 * the dependent schema, exactly as a standalone page would.
 */

import React, { useState } from 'react';
import { useT } from '@greenhouse/ui/lib/i18n';
import type { LucideIcon } from '@greenhouse/ui/lib/icons';

import type { ResolvedCrudSchema } from './schema.js';
import { CrudPage } from './crud-page.js';
import { tr } from './util.js';

export interface CrudTab {
  key: string;
  /** Literal or dotted i18n key. */
  label: string;
  icon?: LucideIcon;
  // A tab holds a schema for any row shape; the row type is erased at the tab boundary.
  schema: ResolvedCrudSchema<any>;
}

export interface CrudTabsProps {
  tabs: CrudTab[];
  /** Controlled active key; falls back to internal state. */
  active?: string;
  onActiveChange?: (key: string) => void;
}

export function CrudTabs({ tabs, active, onActiveChange }: CrudTabsProps) {
  const t = useT();
  const [internal, setInternal] = useState(tabs[0]?.key ?? '');
  const activeKey = active ?? internal;
  const current = tabs.find((tb) => tb.key === activeKey) ?? tabs[0];

  const select = (key: string) => {
    if (onActiveChange) onActiveChange(key);
    else setInternal(key);
  };

  return (
    <div className="space-y-4">
      <div className="flex gap-1 border-b border-edge">
        {tabs.map((tb) => {
          const Icon = tb.icon;
          const on = tb.key === current?.key;
          return (
            <button
              key={tb.key}
              onClick={() => select(tb.key)}
              className={`inline-flex items-center gap-1.5 px-3 py-2 text-sm border-b-2 -mb-px transition-colors ${
                on ? 'border-primary-500 text-fg font-medium' : 'border-transparent text-fg-muted hover:text-fg'
              }`}
            >
              {Icon && <Icon size={15} />}
              {tr(t, tb.label)}
            </button>
          );
        })}
      </div>

      {current && <CrudPage key={current.key} schema={current.schema} />}
    </div>
  );
}
