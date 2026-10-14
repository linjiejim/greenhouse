/**
 * Dashboard cards (TBL-13): what each card of a dashboard shows, worked out with the reader's access.
 * Being written: see the phase 2 brief.
 */

import type { ViewConfig } from '@greenhouse/contract';
import type { TablesKit } from './kit.js';

export function createCards(kit: TablesKit) {
  void kit;
  return {
    /** A dashboard's settings kept to what its base has (its cards' tables and fields). */
    async cleanDashboard(baseId: string, config: ViewConfig): Promise<ViewConfig> {
      void baseId;
      return { cards: config.cards ?? [] };
    },
  };
}

export type CardsPart = ReturnType<typeof createCards>;
