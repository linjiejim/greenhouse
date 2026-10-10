/**
 * Tables · Formula editor, functions and lookup configuration.
 * Owned by slice Fx; spread into `tables` by ./zh.ts (keys resolve as `tables.<namespace>.*`).
 */

import type { DeepRecord } from '../types';
import type { tablesFormulaEn } from './formula.en';

export const tablesFormulaZh: DeepRecord<typeof tablesFormulaEn> = {
  formula: {
    concat: '拼接',
    add: '相加',
    subtract: '相减',
    multiply: '相乘',
    divide: '相除',
    eq: '等于',
    neq: '不等于',
    gt: '大于',
    gte: '大于等于',
    lt: '小于',
    lte: '小于等于',
    and: '且',
    or: '或',
  },
};
