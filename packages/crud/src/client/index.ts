/**
 * @greenhouse/crud — the low-code CRUD client. A single `defineCrud` schema
 * drives <CrudPage/> (list + filters + form + detail + delete). The three
 * pieces are also exported standalone for bespoke pages.
 *
 * The app must install its UI kit via installCrudUi() before the first render —
 * in apps/web that happens in pages/settings/crud.ts; import crud from there.
 */

export * from './schema.js';
export * from './data-source.js';
export { installCrudUi, type CrudUiKit } from './ui.js';
export { CrudPage } from './crud-page.js';
export type { CrudPageProps } from './crud-page.js';
export { CrudForm } from './crud-form.js';
export type { CrudFormProps } from './crud-form.js';
export { CrudDetail } from './crud-detail.js';
export type { CrudDetailProps } from './crud-detail.js';
export { CrudTabs } from './crud-tabs.js';
export type { CrudTabsProps, CrudTab } from './crud-tabs.js';
export { CrudFieldInput } from './fields.js';
export { renderCell } from './columns.js';
export { usePersistedPageSize, tr, formatCell } from './util.js';

export type { FilterItem, FilterMethod, ListParams, ListResult, SortItem } from '../protocol/types.js';
