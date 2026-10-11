/**
 * Guard: every record read, write and aggregate takes a NON-optional access
 * scope, and every write a non-optional write meta (spec
 * docs/specs/20261011-tables-foundation.md §0; same reasoning as the Bots
 * memory scope in packages/db/src/AGENTS.md). An optional scope would let a
 * forgotten argument silently mean "everything".
 *
 * The type-level checks fail `pnpm typecheck` (this file is under
 * packages/db/src, so it is compiled); the runtime checks catch a default value
 * slipping in front of the scope.
 */

import { describe, expect, it } from 'vitest';
import type { TableAccessScope } from '@greenhouse/types/table-access';
import type { TableRecordWriteMeta } from '@greenhouse/types/tables';
import type { Db } from '../../../client.js';
import { createTablesService, type TablesService } from '../index.js';

type Method = (...args: never[]) => unknown;
type ParamAt<F, I extends number> = F extends (...args: infer A) => unknown ? A[I] : never;
/** True only when parameter `I` of `F` is required and is exactly `T`. */
type RequiredParam<F, I extends number, T> =
  undefined extends ParamAt<F, I>
    ? false
    : [ParamAt<F, I>] extends [T]
      ? [T] extends [ParamAt<F, I>]
        ? true
        : false
      : false;
type Expect<T extends true> = T;

/** Method → index of its scope parameter. */
const SCOPE_PARAM = {
  getRecord: 2,
  recordQueryParts: 2,
  queryRecords: 2,
  aggregateRecords: 2,
  createRecord: 1,
  updateRecord: 1,
  deleteRecord: 1,
  restoreRecord: 1,
  listDeletedRecords: 1,
  validateBatchRecords: 1,
  batchUpsertRecords: 1,
  submitForm: 2,
  commitImportChunk: 1,
  matchImportRelationLabels: 3,
  listRecordActivity: 3,
  createComment: 1,
  updateComment: 2,
  deleteComment: 1,
} as const satisfies Partial<Record<keyof TablesService, number>>;

/** Write method → index of its meta parameter. */
const META_PARAM = {
  createRecord: 2,
  updateRecord: 2,
  deleteRecord: 2,
  restoreRecord: 2,
  batchUpsertRecords: 2,
  submitForm: 3,
  commitImportChunk: 2,
} as const satisfies Partial<Record<keyof TablesService, number>>;

type S = TablesService;
type ScopeGuards = [
  Expect<RequiredParam<S['getRecord'], 2, TableAccessScope>>,
  Expect<RequiredParam<S['recordQueryParts'], 2, TableAccessScope>>,
  Expect<RequiredParam<S['queryRecords'], 2, TableAccessScope>>,
  Expect<RequiredParam<S['aggregateRecords'], 2, TableAccessScope>>,
  Expect<RequiredParam<S['createRecord'], 1, TableAccessScope>>,
  Expect<RequiredParam<S['updateRecord'], 1, TableAccessScope>>,
  Expect<RequiredParam<S['deleteRecord'], 1, TableAccessScope>>,
  Expect<RequiredParam<S['restoreRecord'], 1, TableAccessScope>>,
  Expect<RequiredParam<S['listDeletedRecords'], 1, TableAccessScope>>,
  Expect<RequiredParam<S['validateBatchRecords'], 1, TableAccessScope>>,
  Expect<RequiredParam<S['batchUpsertRecords'], 1, TableAccessScope>>,
  Expect<RequiredParam<S['submitForm'], 2, TableAccessScope>>,
  Expect<RequiredParam<S['commitImportChunk'], 1, TableAccessScope>>,
  Expect<RequiredParam<S['matchImportRelationLabels'], 3, TableAccessScope>>,
  // Activity: the row scope and the (kernel-capped) read scope for field changes.
  Expect<RequiredParam<S['listRecordActivity'], 2, TableAccessScope>>,
  Expect<RequiredParam<S['listRecordActivity'], 3, TableAccessScope>>,
  Expect<RequiredParam<S['createComment'], 1, TableAccessScope>>,
  Expect<RequiredParam<S['updateComment'], 2, TableAccessScope>>,
  Expect<RequiredParam<S['deleteComment'], 1, TableAccessScope>>,
];
type MetaGuards = [
  Expect<RequiredParam<S['createRecord'], 2, TableRecordWriteMeta>>,
  Expect<RequiredParam<S['updateRecord'], 2, TableRecordWriteMeta>>,
  Expect<RequiredParam<S['deleteRecord'], 2, TableRecordWriteMeta>>,
  Expect<RequiredParam<S['restoreRecord'], 2, TableRecordWriteMeta>>,
  Expect<RequiredParam<S['batchUpsertRecords'], 2, TableRecordWriteMeta>>,
  Expect<RequiredParam<S['submitForm'], 3, TableRecordWriteMeta>>,
  Expect<RequiredParam<S['commitImportChunk'], 2, TableRecordWriteMeta>>,
];

describe('Tables record methods require an access scope and write meta', () => {
  // Factories only build closures; nothing touches the database here.
  const service = createTablesService({} as Db);

  it('declares the scope / meta parameters before any defaulted parameter', () => {
    const guards: [ScopeGuards, MetaGuards] | undefined = undefined;
    expect(guards).toBeUndefined();
    for (const [name, index] of Object.entries(SCOPE_PARAM)) {
      const method = service[name as keyof typeof SCOPE_PARAM] as Method;
      // Function.length stops at the first defaulted parameter.
      expect(method.length, `${name} scope parameter`).toBeGreaterThan(index);
    }
    for (const [name, index] of Object.entries(META_PARAM)) {
      const method = service[name as keyof typeof META_PARAM] as Method;
      expect(method.length, `${name} meta parameter`).toBeGreaterThan(index);
    }
  });

  it('refuses a call that omits the scope at runtime too', async () => {
    const call = service.getRecord as unknown as (...args: unknown[]) => Promise<unknown>;
    await expect(call(1, 1)).rejects.toThrow(/scope is required/);
  });
});
