/** The dashboards and cards calls of the typed client (`client.tables.cards`). */

import type { KnowledgeHttp } from './knowledge-client.js';
import type { CardData, CreateDashboardInput, DashboardData } from './tables-cards.js';
import type { Card, View } from './tables.js';

export function cardsApi(http: KnowledgeHttp) {
  return {
    /**
     * A dashboard of a base, without cards: shared (builders) or only mine. Rename, reorder,
     * change its cards or delete it with `tables.views.update` and `tables.views.remove`.
     */
    createDashboard: (baseId: string, input: CreateDashboardInput) =>
      http.post<View>(`/api/tables/bases/${encodeURIComponent(baseId)}/dashboards`, input),
    /** What every card of a dashboard shows me now; each card succeeds or fails on its own. */
    dashboard: (viewId: string) => http.get<DashboardData>(`/api/tables/views/${encodeURIComponent(viewId)}/cards`),
    /** What one card shows me, saved or not. */
    query: (card: Card) => http.post<CardData>('/api/tables/cards/query', { card }),
  };
}
