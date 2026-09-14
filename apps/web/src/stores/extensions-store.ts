/**
 * Active extensions of the connected deployment (`GET /api/extensions`).
 *
 * Web extensions are compiled in (apps/web/src/extensions/index.ts) but only
 * rendered when the API reports their id as active, so one web build serves
 * deployments with different extension sets.
 */
import { create } from 'zustand';
import { authFetch } from '../lib/auth';

export interface ActiveExtension {
  id: string;
  name: string;
  description: string | null;
}

interface ExtensionsStore {
  extensions: ActiveExtension[];
  loaded: boolean;
  load: () => Promise<void>;
  reset: () => void;
}

export const useExtensionsStore = create<ExtensionsStore>((set) => ({
  extensions: [],
  loaded: false,
  load: async () => {
    try {
      const res = await authFetch('/api/extensions');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { extensions: ActiveExtension[] };
      set({ extensions: data.extensions, loaded: true });
    } catch {
      // Fail closed: an unreachable list means no extension UI, never a broken one.
      set({ extensions: [], loaded: true });
    }
  },
  reset: () => set({ extensions: [], loaded: false }),
}));

/** Whether the deployment runs the extension with this id. */
export function useHasExtension(id: string): boolean {
  return useExtensionsStore((s) => s.extensions.some((e) => e.id === id));
}

export function useExtensionName(id: string): string | undefined {
  return useExtensionsStore((s) => s.extensions.find((e) => e.id === id)?.name);
}

export function activeExtensionIds(): string[] {
  return useExtensionsStore.getState().extensions.map((e) => e.id);
}
