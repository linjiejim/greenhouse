/**
 * A @greenhouse/crud page that can write must say so.
 *
 * `defineCrud` defaults every permission to false (packages/crud/src/client/schema.ts).
 * A page can therefore ship a complete write surface — update/remove on the data
 * source, form fields, a delete confirmation — and render none of it: with
 * canEdit/canDelete false the row-actions column is not built at all, so there
 * is no way to reach any of it. Nothing else catches this. It type-checks, it
 * lints, the endpoints have tests, and the page renders; it is simply inert.
 *
 * That shipped once, in the Frictions review queue (v0.40.0): supers could watch
 * the queue grow and could not acknowledge, resolve, annotate or delete a single
 * row. This test is the guard, and it is deliberately source-level so it covers
 * pages that do not exist yet.
 *
 * Scope: only the `@greenhouse/crud` pages (imported via the settings/crud binding).
 * `components/dashboard` is a separate, older CRUD implementation with its own
 * permission model.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const PAGES_ROOT = new URL('../../apps/web/src/pages', import.meta.url).pathname;

function tsxFilesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return tsxFilesUnder(full);
    return entry.endsWith('.tsx') ? [full] : [];
  });
}

/** Pages built on @greenhouse/crud — the `./crud` binding module re-exports it. */
function crudPages(): Array<{ file: string; source: string }> {
  return tsxFilesUnder(PAGES_ROOT)
    .map((file) => ({ file, source: readFileSync(file, 'utf-8') }))
    .filter(({ source }) => /import\s*\{[^}]*\bdefineCrud\b[^}]*\}\s*from\s*'[^']*\/crud'/.test(source));
}

/** A data-source method, e.g. `async update(id, patch) {`. */
function declaresDataSourceMethod(source: string, method: 'update' | 'remove'): boolean {
  return new RegExp(`^\\s+async ${method}\\(`, 'm').test(source);
}

function declaresAccess(source: string, permission: 'canEdit' | 'canDelete'): boolean {
  return new RegExp(`${permission}:\\s*true`).test(source);
}

describe('@greenhouse/crud pages', () => {
  const pages = crudPages();

  it('finds the pages to check (a silent empty sweep would prove nothing)', () => {
    expect(pages.length).toBeGreaterThan(0);
  });

  it.each([
    ['update', 'canEdit'],
    ['remove', 'canDelete'],
  ] as const)('declare %s access whenever the data source implements it', (method, permission) => {
    const inert = pages
      .filter(({ source }) => declaresDataSourceMethod(source, method) && !declaresAccess(source, permission))
      .map(({ file }) => relative(PAGES_ROOT, file));

    expect(
      inert,
      `these pages implement dataSource.${method}() but never set access.${permission}: true, ` +
        `so ${permission === 'canEdit' ? 'the edit' : 'the delete'} affordance never renders and the code is unreachable`,
    ).toEqual([]);
  });
});
