/**
 * Which half of Settings → My Bots shows — 我的 or 示例 (app/settings/bots.tsx).
 * A store, not page state: the New Bot sheet (app/bots/new-bot.tsx) is a
 * route over it and its 从示例挑一个 switches it before closing. Back to 我的
 * whenever the page goes away.
 */

import { create } from 'zustand';

export type MyBotsTab = 'mine' | 'examples';

export const useMyBotsTab = create<{ tab: MyBotsTab; setTab: (tab: MyBotsTab) => void }>((set) => ({
  tab: 'mine',
  setTab: (tab) => set({ tab }),
}));
