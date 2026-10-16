/**
 * 表格 dashboards (TBL-13): what the cards of a dashboard show me, one request per dashboard
 * config (its revision), and one card for the card editor's preview. Saving cards goes through
 * the view (api.tables.views.update); a new revision asks again.
 */

import { useQuery } from '@tanstack/react-query';
import type { Base, Card, CreateDashboardInput, View } from '@greenhouse/contract';
import { api } from '../lib/api';
import { putView, refreshBase } from './tables';

export const cardsKeys = {
  /** Everything a base's dashboards show: what a change to its records makes stale. */
  base: (baseId: string) => ['tables', 'cards', baseId] as const,
  dashboard: (baseId: string, viewId: string, revision: number) =>
    ['tables', 'cards', baseId, viewId, revision] as const,
  preview: (card: Card) => ['tables', 'cards', 'preview', card] as const,
};

/**
 * Every card of a dashboard. Asked again on every visit, when the window comes back, and every
 * minute while it is open, since a change to the records anywhere in the base may move them;
 * while a new revision loads, the figures before it stay on screen.
 */
export function useDashboardData(base: Pick<Base, 'id'>, view: Pick<View, 'id' | 'revision'>) {
  return useQuery({
    queryKey: cardsKeys.dashboard(base.id, view.id, view.revision),
    queryFn: () => api.tables.cards.dashboard(view.id),
    staleTime: 0,
    refetchInterval: 60_000,
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[3] === view.id ? previous : undefined,
  });
}

/** One card as it would show, for the editor (null: nothing to show yet). */
export function useCardPreview(card: Card | null) {
  return useQuery({
    queryKey: cardsKeys.preview(card ?? ({} as Card)),
    queryFn: () => api.tables.cards.query(card!),
    enabled: !!card,
    staleTime: 15_000,
    placeholderData: (previous) => previous,
  });
}

/** A new dashboard, in the cached base at once (the page finds it by id), then the base again. */
export async function createDashboard(baseId: string, input: CreateDashboardInput): Promise<View> {
  const view = await api.tables.cards.createDashboard(baseId, input);
  putView(baseId, view);
  await refreshBase(baseId);
  return view;
}
