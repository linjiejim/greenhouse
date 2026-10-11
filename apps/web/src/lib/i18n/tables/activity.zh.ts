/**
 * Tables · A record's activity tab: comments, mentions and change history.
 * Owned by slice C; spread into `tables` by ./zh.ts (keys resolve as `tables.<namespace>.*`).
 */

import type { DeepRecord } from '../types';
import type { tablesActivityEn } from './activity.en';

export const tablesActivityZh: DeepRecord<typeof tablesActivityEn> = {
  activity: {},
};
