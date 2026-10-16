/**
 * The skills `/` offers (Zustand), per answering Agent: `GET /api/skills?agent=` judges each one
 * for that Agent (`available`, and why not). Read once per Agent in a run, again after a minute.
 *
 * Per identity: emptied when the member or the station changes.
 */

import { useEffect } from 'react';
import { create } from 'zustand';
import { listSkills } from '../api/me';
import type { Skill } from '../shared/contract';
import { useAuth } from './auth';
import { useStations } from './stations';

const STALE_MS = 60_000;

interface SkillsState {
  byAgent: Record<string, { items: Skill[]; at: number }>;
  generation: number;
  load: (agent: string) => Promise<void>;
  reset: () => void;
}

export const useSkills = create<SkillsState>((set, get) => ({
  byAgent: {},
  generation: 0,
  async load(agent) {
    const known = get().byAgent[agent];
    if (known && Date.now() - known.at < STALE_MS) return;
    const gen = get().generation;
    const page = await listSkills({ agent, limit: 200 });
    if (gen !== get().generation || !page.ok) return;
    set((state) => ({ byAgent: { ...state.byAgent, [agent]: { items: page.data.items, at: Date.now() } } }));
  },
  reset() {
    set({ byAgent: {}, generation: get().generation + 1 });
  },
}));

/** The skills for this Agent (`main` or an id), loading them when needed; null until loaded or when off. */
export function useSkillsFor(agent: string, enabled = true): Skill[] | null {
  const entry = useSkills((s) => s.byAgent[agent]);
  useEffect(() => {
    if (enabled) void useSkills.getState().load(agent);
  }, [agent, enabled]);
  return enabled ? (entry?.items ?? null) : null;
}

let identity = '';
const follow = () => {
  const next = `${useStations.getState().activeId ?? ''}:${useAuth.getState().user?.id ?? ''}`;
  if (next === identity) return;
  identity = next;
  useSkills.getState().reset();
};
useAuth.subscribe(follow);
useStations.subscribe(follow);
