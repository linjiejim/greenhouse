/**
 * GUARD + BEHAVIOR TEST — the CRUD framework fork extension seam.
 *
 * Upstream must register ZERO private field/column widgets (registerCrudExtensions
 * is a no-op). The behavior test proves the seam: a registered widget becomes
 * resolvable via the registry without editing the framework core.
 */

import { describe, it, expect } from 'vitest';
import { registerCrudField, registerCrudColumn, getCrudField, getCrudColumn } from '@greenhouse/crud';
import { registerCrudExtensions } from '../crud.extensions';

describe('crud extension seam', () => {
  it('registers no fork widgets upstream (OSS invariant)', () => {
    registerCrudExtensions();
    expect(getCrudField('__probe_field__')).toBeUndefined();
    expect(getCrudColumn('__probe_column__')).toBeUndefined();
  });

  it('a registered field/column widget resolves through the registry', () => {
    const widget = () => null;
    registerCrudField('editor', widget);
    registerCrudColumn('thumbnail', () => null);
    expect(getCrudField('editor')).toBe(widget);
    expect(getCrudColumn('thumbnail')).toBeTypeOf('function');
  });
});
