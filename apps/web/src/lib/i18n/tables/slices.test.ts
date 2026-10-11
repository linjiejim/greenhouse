/**
 * The per-slice Tables catalogs are spread into `tables` with a shallow spread,
 * so a namespace claimed twice would silently lose one side. Pin that every
 * module owns its namespaces alone and that no core `tables.*` key shadows them.
 */

import { describe, expect, it } from 'vitest';
import en from '../en';
import zh from '../zh';
import { TABLES_PLAN_EN, TABLES_SLICE_MODULES_EN } from './en';
import { TABLES_PLAN_ZH } from './zh';

describe('Tables slice catalogs', () => {
  it('gives every namespace exactly one owner', () => {
    const owners = new Map<string, string>();
    for (const [slice, catalog] of Object.entries(TABLES_SLICE_MODULES_EN)) {
      for (const namespace of Object.keys(catalog)) {
        expect(owners.get(namespace), `tables.${namespace} claimed by ${slice}`).toBeUndefined();
        owners.set(namespace, slice);
      }
    }
  });

  it('lands every slice namespace in the catalog unshadowed by a core key', () => {
    const tables = en.tables as Record<string, unknown>;
    for (const catalog of Object.values(TABLES_SLICE_MODULES_EN)) {
      for (const [namespace, messages] of Object.entries(catalog)) {
        expect(tables[namespace], `tables.${namespace}`).toBe(messages);
      }
    }
    expect(en.tablesSchemaPlan).toBe(TABLES_PLAN_EN);
    expect(zh.tablesSchemaPlan).toBe(TABLES_PLAN_ZH);
  });
});
