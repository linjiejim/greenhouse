/**
 * Tables · View types (kanban, calendar, gallery), grouping and the field panel.
 * Owned by slice V; spread into `tables` by ./zh.ts (keys resolve as `tables.<namespace>.*`).
 */

import type { DeepRecord } from '../types';
import type { tablesViewsEn } from './views.en';

export const tablesViewsZh: DeepRecord<typeof tablesViewsEn> = {
  views: {},
};
