/**
 * The server's spec problems land next to what they are about: grouped by
 * the ids the validator attaches (indexes shift as the builder edits; ids do
 * not), with paths relative to the card, page or role.
 */

import { describe, expect, it } from 'vitest';
import type { AppSpecError } from '@greenhouse/types/apps';
import {
  actionErrors,
  appErrors,
  cardErrors,
  errorsUnder,
  pageErrorCount,
  pageOwnErrors,
  relativePath,
  roleErrors,
} from './spec-errors';

const errors: AppSpecError[] = [
  { path: 'pages[1].cards[0].actions[0].do', pageId: 'approve', cardId: 'queue', actionId: 'ok', message: 'a' },
  { path: 'pages[1].cards[0].source.query', pageId: 'approve', cardId: 'queue', message: 'b' },
  { path: 'pages[1].filters[0]', pageId: 'approve', filterId: 'status', message: 'c' },
  { path: 'roles[0].tables[0].tableId', roleKey: 'applicant', message: 'd' },
  { path: 'home', message: 'e' },
];

describe('spec errors', () => {
  it('reads paths relative to the card, page or role', () => {
    expect(errors.map(relativePath)).toEqual([
      'actions[0].do',
      'source.query',
      'filters[0]',
      'tables[0].tableId',
      'home',
    ]);
  });

  it('groups by card, page, role and action', () => {
    expect(cardErrors(errors, 'approve', 'queue').map((error) => error.message)).toEqual(['a', 'b']);
    expect(pageOwnErrors(errors, 'approve').map((error) => error.message)).toEqual(['c']);
    expect(pageErrorCount(errors, 'approve')).toBe(3);
    expect(roleErrors(errors, 'applicant').map((error) => error.message)).toEqual(['d']);
    expect(appErrors(errors).map((error) => error.message)).toEqual(['e']);
    expect(actionErrors(errors, 'ok').map((error) => error.message)).toEqual(['a']);
  });

  it('finds what sits under a setting, not what merely shares its prefix', () => {
    const card = cardErrors(errors, 'approve', 'queue');
    expect(errorsUnder(card, 'actions[0]').map((error) => error.message)).toEqual(['a']);
    expect(errorsUnder(card, 'source').map((error) => error.message)).toEqual(['b']);
    expect(errorsUnder(card, 'sourc')).toEqual([]);
  });
});
