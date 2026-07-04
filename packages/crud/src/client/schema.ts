/**
 * CrudSchema<TRow> — one declarative object that drives the list table, the
 * add/edit form, and the read-only detail view. Field and column definitions
 * are discriminated unions keyed on `type`, and keys are constrained to
 * `keyof TRow`, so a typo or a wrong per-type option is a compile error rather
 * than a silent runtime fallback.
 *
 * Escape hatches, narrowest → widest:
 *   - field/column `type: 'custom'` with a render fn (fully typed, inline)
 *   - `type: 'extension'` referencing a fork-registered widget (registry.ts)
 *   - slots (toolbar / empty / rowExpand), tableActions, pageActions, detailTabs
 *   - use CrudPage / CrudForm / CrudDetail standalone in a bespoke page
 */

import type { ReactNode } from 'react';
import type { LucideIcon } from '@greenhouse/ui/lib/icons';

import type { FilterMethod, SortItem } from '../protocol/types.js';
import type { CrudDataSource } from './data-source.js';
import type { CrudFieldRenderProps } from './registry.js';

export type BadgeTone = 'default' | 'secondary' | 'success' | 'warning' | 'destructive';
export type RowKey<TRow> = Extract<keyof TRow, string>;

export interface SelectOption {
  value: string | number | boolean;
  label: string;
}

export type OptionsSource = SelectOption[] | ((query?: string) => Promise<SelectOption[]>);

export interface ValidationRule {
  /** Return an error message string when invalid, or null/undefined when valid. */
  validate: (value: unknown, form: Record<string, unknown>) => string | null | undefined;
}

// ─── Columns (list table) ────────────────────────────────

interface ColumnBase {
  label: string;
  width?: string;
  sortable?: boolean;
  align?: 'left' | 'center' | 'right';
  /** Hide below this breakpoint. */
  responsiveHide?: 'sm' | 'md' | 'lg';
  /** Present in the detail view but not the list table. */
  hidden?: boolean;
}

export type ColumnDef<TRow> =
  | (ColumnBase & {
      key: RowKey<TRow>;
      type?: 'text' | 'longtext' | 'number' | 'date' | 'datetime' | 'boolean' | 'tags';
      truncate?: number;
    })
  | (ColumnBase & { key: RowKey<TRow>; type: 'badge'; badgeMap?: Record<string, BadgeTone> })
  | (ColumnBase & { key: string; type: 'custom'; render: (row: TRow) => ReactNode })
  | (ColumnBase & { key: string; type: 'extension'; name: string; config?: Record<string, unknown> });

// ─── Filters (list toolbar) ──────────────────────────────

export interface FilterDef<TRow> {
  key: RowKey<TRow>;
  label: string;
  kind: 'text' | 'select' | 'boolean' | 'daterange';
  /** Protocol method to emit. Defaults: text→like, select→eq, boolean→eq, daterange→between. */
  method?: FilterMethod;
  options?: OptionsSource;
  placeholder?: string;
  /** Hidden behind a "More" toggle. */
  secondary?: boolean;
}

// ─── Form fields (add / edit) ────────────────────────────

interface FieldBase<TRow> {
  key: RowKey<TRow>;
  label: string;
  /** Grid width in quarters: 1=25% … 4=100% (default 4). */
  width?: 1 | 2 | 3 | 4;
  tab?: string;
  required?: boolean;
  placeholder?: string;
  comment?: string;
  defaultValue?: unknown;
  visible?: (form: Record<string, unknown>) => boolean;
  disabled?: (form: Record<string, unknown>) => boolean;
  rules?: ValidationRule[];
  /** Restrict a field to specific modes (default: shown in both add & edit). */
  allows?: { add?: boolean; edit?: boolean };
}

export type FieldDef<TRow> =
  | ({ type: 'text' | 'password' | 'email' | 'url' } & FieldBase<TRow> & { maxLength?: number })
  | ({ type: 'textarea' } & FieldBase<TRow> & { rows?: number })
  | ({ type: 'number' } & FieldBase<TRow> & { min?: number; max?: number; step?: number })
  | ({ type: 'select' | 'radio' } & FieldBase<TRow> & { options: OptionsSource })
  | ({ type: 'multi-select' } & FieldBase<TRow> & { options: OptionsSource })
  | ({ type: 'tags' } & FieldBase<TRow>)
  | ({ type: 'switch' | 'date' | 'datetime' | 'json' | 'readonly' } & FieldBase<TRow>)
  | { type: 'divider'; label?: string; tab?: string }
  | ({ type: 'custom' } & FieldBase<TRow> & { render: (props: CrudFieldRenderProps) => ReactNode })
  | ({ type: 'extension'; name: string; config?: Record<string, unknown> } & FieldBase<TRow>);

export interface FormTab {
  key: string;
  label: string;
}

// ─── Actions ─────────────────────────────────────────────

export interface TableActionDef<TRow> {
  key: string;
  label: string | ((row: TRow) => string);
  icon?: LucideIcon;
  tone?: 'default' | 'primary' | 'success' | 'warning' | 'danger';
  visible?: (row: TRow) => boolean;
  onClick: (row: TRow, ctx: CrudActionContext) => void | Promise<void>;
}

export interface PageActionDef {
  key: string;
  label: string;
  icon?: LucideIcon;
  onClick: (ctx: CrudActionContext) => void | Promise<void>;
}

/** Handed to actions so they can trigger a reload or open the built-in forms. */
export interface CrudActionContext {
  reload: () => void;
  openCreate: () => void;
  openEdit: (row: Record<string, unknown>) => void;
  openDetail: (row: Record<string, unknown>) => void;
}

// ─── Detail view ─────────────────────────────────────────

export type DetailTabDef<TRow> =
  | { key: string; label: string; kind: 'fields'; fields?: RowKey<TRow>[] }
  | { key: string; label: string; kind: 'custom'; render: (row: TRow) => ReactNode };

// ─── Access + slots ──────────────────────────────────────

export interface CrudAccess {
  canView?: boolean;
  canAdd?: boolean;
  canEdit?: boolean;
  canDelete?: boolean;
  /** Per-row override — hide the edit action for rows this returns false for. */
  canEditRow?: (row: Record<string, unknown>) => boolean;
  /** Per-row override — hide the delete action for rows this returns false for. */
  canDeleteRow?: (row: Record<string, unknown>) => boolean;
}

export interface CrudSlots<TRow> {
  /** Replace the default toolbar entirely. */
  toolbar?: (ctx: CrudActionContext & { total: number }) => ReactNode;
  /** Rendered above the table (below toolbar) — banners, callouts. */
  banner?: (ctx: CrudActionContext) => ReactNode;
  empty?: ReactNode;
  /** Expandable content under a row (click to toggle). */
  rowExpand?: (row: TRow, ctx: CrudActionContext) => ReactNode;
}

// ─── Full schema ─────────────────────────────────────────

export interface CrudSchema<TRow = Record<string, unknown>> {
  /** Display name (literal or a dotted i18n key). */
  name: string;
  dataSource: CrudDataSource<TRow>;
  /** Primary-key field. Default 'id'. */
  idField?: RowKey<TRow>;
  icon?: LucideIcon;

  columns: ColumnDef<TRow>[];
  filters?: FilterDef<TRow>[];
  defaultSort?: SortItem;
  pageSize?: number;
  /** Persisted-page-size scope key (localStorage). Defaults to name. */
  storageKey?: string;

  formFields?: FieldDef<TRow>[];
  formTabs?: FormTab[];
  formMode?: 'dialog' | 'drawer';
  /** Title builder for the add/edit form; defaults to "Add {name}" / "Edit {name}". */
  formTitle?: (mode: 'add' | 'edit', row: TRow | null) => string;

  access?: CrudAccess;
  tableActions?: TableActionDef<TRow>[];
  pageActions?: PageActionDef[];
  detailTabs?: DetailTabDef<TRow>[];
  slots?: CrudSlots<TRow>;

  emptyMessage?: string;
  /** Row click behavior. Default: 'detail' if canView & no rowExpand, else none. */
  onRowClick?: 'detail' | 'edit' | 'none';
}

export interface ResolvedCrudSchema<TRow> extends CrudSchema<TRow> {
  idField: RowKey<TRow>;
  filters: FilterDef<TRow>[];
  formFields: FieldDef<TRow>[];
  formTabs: FormTab[];
  formMode: 'dialog' | 'drawer';
  pageSize: number;
  storageKey: string;
  access: {
    canView: boolean;
    canAdd: boolean;
    canEdit: boolean;
    canDelete: boolean;
    canEditRow?: (row: Record<string, unknown>) => boolean;
    canDeleteRow?: (row: Record<string, unknown>) => boolean;
  };
  tableActions: TableActionDef<TRow>[];
  pageActions: PageActionDef[];
}

export function defineCrud<TRow>(schema: CrudSchema<TRow>): ResolvedCrudSchema<TRow> {
  return {
    ...schema,
    idField: schema.idField ?? ('id' as RowKey<TRow>),
    filters: schema.filters ?? [],
    formFields: schema.formFields ?? [],
    formTabs: schema.formTabs ?? [],
    formMode: schema.formMode ?? 'dialog',
    pageSize: schema.pageSize ?? 20,
    storageKey: schema.storageKey ?? `crud:${schema.name}`,
    access: {
      canView: schema.access?.canView ?? (schema.detailTabs != null || false),
      canAdd: schema.access?.canAdd ?? false,
      canEdit: schema.access?.canEdit ?? false,
      canDelete: schema.access?.canDelete ?? false,
      canEditRow: schema.access?.canEditRow,
      canDeleteRow: schema.access?.canDeleteRow,
    },
    tableActions: schema.tableActions ?? [],
    pageActions: schema.pageActions ?? [],
  };
}

// ─── Helpers shared by form/detail ───────────────────────

export function isInputField<TRow>(f: FieldDef<TRow>): f is Extract<FieldDef<TRow>, { key: RowKey<TRow> }> {
  return f.type !== 'divider';
}

export function fieldsForMode<TRow>(fields: FieldDef<TRow>[], mode: 'add' | 'edit'): FieldDef<TRow>[] {
  return fields.filter((f) => {
    if (f.type === 'divider') return true;
    if (!f.allows) return true;
    return f.allows[mode] !== false;
  });
}

export function formDefaults<TRow>(fields: FieldDef<TRow>[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.type === 'divider') continue;
    if (f.defaultValue !== undefined) out[f.key] = f.defaultValue;
  }
  return out;
}
