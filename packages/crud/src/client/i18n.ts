/**
 * Framework chrome strings (buttons / empty states / confirm dialogs), keyed
 * under `crud.*`. This repo's settings CRUD pages follow the dashboard CRUD
 * catalog. Host apps may inject their own runtime translator through CrudUiKit;
 * these messages remain the standalone fallback.
 */

import { getCrudUi } from './ui.js';

const MESSAGES: Record<string, string> = {
  'crud.add': 'Add',
  'crud.edit': 'Edit',
  'crud.view': 'View',
  'crud.delete': 'Delete',
  'crud.create': 'Create',
  'crud.save': 'Save',
  'crud.saving': 'Saving…',
  'crud.cancel': 'Cancel',
  'crud.search': 'Search',
  'crud.filters': 'Filters',
  'crud.moreFilters': 'More',
  'crud.reset': 'Reset',
  'crud.total': '{count} total',
  'crud.empty': 'No records found',
  'crud.loadFailed': 'Failed to load',
  'crud.saveFailed': 'Failed to save',
  'crud.deleteFailed': 'Failed to delete',
  'crud.deleted': 'Deleted',
  'crud.saved': 'Saved',
  'crud.created': 'Created',
  'crud.updated': 'Updated',
  'crud.confirmDeleteTitle': 'Delete this record?',
  'crud.confirmDeleteBody': 'This action cannot be undone.',
  'crud.required': 'This field is required',
  'crud.actions': 'Actions',
  'crud.close': 'Close',
  'crud.all': 'All',
};

/** Resolve a `crud.*` chrome key; unknown keys pass through unchanged (so
 *  `tr()` can hand any literal label to this safely). */
export function t(key: string, params?: Record<string, string | number>): string {
  let msg = MESSAGES[key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      msg = msg.replace(`{${k}}`, String(v));
    }
  }
  return msg;
}

/** Resolve the host translator at render time so locale changes update every
 * CRUD surface without duplicating chrome labels in each schema. */
export function useCrudT(): typeof t {
  return getCrudUi().useT?.() ?? t;
}
