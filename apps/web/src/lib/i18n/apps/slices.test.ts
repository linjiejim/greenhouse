/**
 * The per-slice Apps catalogs are spread into `apps` with a shallow spread, so
 * a namespace claimed twice would silently lose one side. Pin that every module
 * owns its namespaces alone, that no core `apps.*` key shadows them, and that
 * the Phase 1 slices each have their module (same contract as ../tables).
 */

import { describe, expect, it } from 'vitest';
import en from '../en';
import zh from '../zh';
import { APPS_SLICE_MODULES_EN } from './en';
import { APPS_SLICE_MODULES_ZH } from './zh';

describe('Apps slice catalogs', () => {
  it('has one module per Phase 1 slice, named after its namespace', () => {
    expect(Object.keys(APPS_SLICE_MODULES_EN).sort()).toEqual([
      'agent',
      'builder',
      'center',
      'runtime',
      'sandbox',
      'templates',
    ]);
    for (const [slice, catalog] of Object.entries(APPS_SLICE_MODULES_EN)) {
      expect(Object.keys(catalog), slice).toEqual([slice]);
    }
    expect(Object.keys(APPS_SLICE_MODULES_ZH).sort()).toEqual(Object.keys(APPS_SLICE_MODULES_EN).sort());
  });

  it('gives every namespace exactly one owner', () => {
    const owners = new Map<string, string>();
    for (const [slice, catalog] of Object.entries(APPS_SLICE_MODULES_EN)) {
      for (const namespace of Object.keys(catalog)) {
        expect(owners.get(namespace), `apps.${namespace} claimed by ${slice}`).toBeUndefined();
        owners.set(namespace, slice);
      }
    }
  });

  it('lands every slice namespace in both catalogs unshadowed by a core key', () => {
    const english = en.apps as Record<string, unknown>;
    const chinese = zh.apps as Record<string, unknown>;
    for (const catalog of Object.values(APPS_SLICE_MODULES_EN)) {
      for (const [namespace, messages] of Object.entries(catalog)) {
        expect(english[namespace], `apps.${namespace}`).toBe(messages);
      }
    }
    for (const catalog of Object.values(APPS_SLICE_MODULES_ZH)) {
      for (const [namespace, messages] of Object.entries(catalog)) {
        expect(chinese[namespace], `apps.${namespace} (zh)`).toBe(messages);
      }
    }
  });
});
