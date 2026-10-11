/**
 * The choice sheet's channel (`app/tables/pick.tsx`, spec §3: multi-select and
 * people "勾选列表 sheet", relations "记录选择 sheet"). A form opens the sheet
 * with a request (handoff `?k=`: title, single / multiple, where the choices
 * come from, what is selected now) and reads the answer back from this store
 * by the request id — results travel through zustand, never callbacks
 * (apps/mobile/AGENTS.md "结果回传走 zustand store").
 *
 * Sources:
 *  - `options` — a fixed list (select options, the user directory);
 *  - `records` — a Tables relation: the target table's rows I can read
 *    (searchable, titled by their primary field);
 *  - `app`     — an app card's user / relation field: the gateway's
 *    `/options` (people for user fields; rows in my role's read scope for
 *    relations).
 */

import { create } from 'zustand';
import type { Href } from 'expo-router';
import { putHandoff } from '../lib/handoff';

export interface PickChoice {
  value: string | number;
  label: string;
  detail?: string;
}

export type PickSource =
  | { kind: 'options'; choices: PickChoice[] }
  | { kind: 'records'; tableId: number }
  | { kind: 'app'; appId: number; pageId: string; cardId: string; fieldId: number; buttonId?: string };

export interface PickRequest {
  /** Unique per form field (`<form instance>:<field id>`). */
  id: string;
  /** The gate of the surface that opened it (src/tables/route-gate.tsx). */
  area: 'tables' | 'apps' | 'internal';
  title: string;
  multiple: boolean;
  source: PickSource;
  selected: Array<string | number>;
  /** Labels already known for the selected values (shown before the choices load). */
  labels?: Record<string, string>;
}

export interface PickResult {
  values: Array<string | number>;
  labels: Record<string, string>;
  /** Bumped per answer, so the same values picked twice still read as an answer. */
  seq: number;
}

interface PickState {
  results: Record<string, PickResult | undefined>;
  answer: (id: string, values: Array<string | number>, labels: Record<string, string>) => void;
  forget: (id: string) => void;
}

let seq = 0;

export const usePick = create<PickState>((set) => ({
  results: {},
  answer(id, values, labels) {
    set((s) => ({ results: { ...s.results, [id]: { values, labels, seq: ++seq } } }));
  },
  forget(id) {
    set((s) => {
      const results = { ...s.results };
      delete results[id];
      return { results };
    });
  },
}));

/** The sheet's address for a request. */
export function pickHref(request: PickRequest): Href {
  return { pathname: '/tables/pick', params: { k: putHandoff('pick', request) } };
}
