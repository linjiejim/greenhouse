/**
 * Active extensions of the connected deployment (`GET /api/extensions`).
 *
 * Web extensions are compiled in (apps/web/src/extensions/index.ts) but only
 * rendered when the API reports their id as active, so one web build serves
 * deployments with different extension sets.
 */
import { create } from 'zustand';
import { registerEntityKinds, extensionEntityKinds } from '@greenhouse/types/entity-links';
import type { ExtensionEntityKindDef } from '@greenhouse/types/entity-links';
import { registerWidgetRecipes, allWidgetRecipes } from '@greenhouse/types/workbench';
import type { WidgetRecipe } from '@greenhouse/types/workbench';
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
      const data = (await res.json()) as {
        extensions: ActiveExtension[];
        entityKinds?: ExtensionEntityKindDef[];
        workbenchRecipes?: WidgetRecipe[];
      };
      // Registration is idempotent on purpose: the store reloads after a
      // re-login, and the shared registries reject a duplicate outright.
      const knownKinds = new Set(extensionEntityKinds().map((def) => def.kind));
      registerEntityKinds((data.entityKinds ?? []).filter((def) => !knownKinds.has(def.kind)));
      const knownRecipes = new Set(allWidgetRecipes().map((recipe) => recipe.id));
      registerWidgetRecipes((data.workbenchRecipes ?? []).filter((recipe) => !knownRecipes.has(recipe.id)));
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
