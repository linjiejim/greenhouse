/**
 * Tables · Base access: group members, custom roles (row / field rules), team role, owner transfer.
 * Owned by slice A; spread into `tables` by ./zh.ts (keys resolve as `tables.<namespace>.*`).
 */

import type { DeepRecord } from '../types';
import type { tablesAccessEn } from './access.en';

export const tablesAccessZh: DeepRecord<typeof tablesAccessEn> = {
  access: {},
};
