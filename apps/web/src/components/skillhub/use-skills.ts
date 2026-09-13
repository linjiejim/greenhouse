/**
 * useSkills — shared skill-catalog loader for SkillHub.
 *
 * The grouped list lives in the global sidebar rail while the detail/landing
 * lives in the main content — two separate React trees that both need the full
 * catalog. A module-level cache + subscriber set means they share ONE fetch, and
 * `reloadSkills()` (after archive/unarchive/delete) refreshes every consumer.
 *
 * Feature-scoped state, not global app state, so it stays a local hook rather
 * than a Zustand store (AGENTS.md: stores/ is for global state).
 */

import { useEffect, useState } from 'react';
import { listSkills, type SkillSummary } from '../../lib/api/skills';

interface SkillsState {
  skills: SkillSummary[] | null;
  loading: boolean;
  error: string | null;
}

let cache: SkillSummary[] | null = null;
let lastError: string | null = null;
let inflight: Promise<void> | null = null;
// Monotonic id of the newest requested fetch. Only the newest fetch is allowed
// to write cache/inflight, so a stale in-flight fetch (e.g. the initial load
// still running when a post-mutation reload fires) can't clobber fresher data.
let generation = 0;
const subscribers = new Set<() => void>();

function notify() {
  subscribers.forEach((fn) => fn());
}

async function load(force = false): Promise<void> {
  // Reuse an in-flight fetch for plain loads, but `force` (a reload) must start
  // a fresh one — the running fetch may predate the mutation being reloaded for.
  if (inflight && !force) return inflight;
  const gen = ++generation;
  const p = (async () => {
    try {
      // Small catalog (≈15 built-in + a few team); 100 covers it. Group + search
      // happen client-side, so we pull the whole set at once (status: 'all').
      const { skills } = await listSkills({ status: 'all', limit: 100 });
      if (gen === generation) {
        cache = skills;
        lastError = null;
      }
    } catch (e) {
      if (gen === generation) lastError = e instanceof Error ? e.message : 'Failed to load skills';
    } finally {
      if (gen === generation) {
        inflight = null;
        notify();
      }
    }
  })();
  inflight = p;
  return p;
}

/** Force a refetch and notify all mounted consumers (call after a mutation). */
export async function reloadSkills(): Promise<void> {
  cache = null;
  await load(true);
}

export function useSkills(): SkillsState & { reload: () => Promise<void> } {
  const [, force] = useState(0);

  useEffect(() => {
    const rerender = () => force((n) => n + 1);
    subscribers.add(rerender);
    if (cache === null && !inflight) void load();
    return () => {
      subscribers.delete(rerender);
    };
  }, []);

  return {
    skills: cache,
    loading: cache === null && lastError === null,
    error: lastError,
    reload: reloadSkills,
  };
}
