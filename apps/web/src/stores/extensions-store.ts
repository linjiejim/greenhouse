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
import { authFetch } from '../lib/auth';

/**
 * Compiled web halves this build refused (sdk / core mismatch), set once by
 * extensions/index.ts. The store drops them from what the API reports, so no
 * reader of `extensions` ever sees a rejected extension as active.
 */
let incompatible: ReadonlySet<string> = new Set();

export function setIncompatibleExtensionIds(ids: Iterable<string>): void {
  incompatible = new Set(ids);
  const { extensions } = useExtensionsStore.getState();
  if (extensions.some((e) => incompatible.has(e.id))) {
    useExtensionsStore.setState({ extensions: extensions.filter((e) => !incompatible.has(e.id)) });
  }
}

const kindOwner = (kind: string) => /^ext:([^:]+):/.exec(kind)?.[1];

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
      };
      // Registration is idempotent on purpose: the store reloads after a
      // re-login, and the shared registries reject a duplicate outright.
      const knownKinds = new Set(extensionEntityKinds().map((def) => def.kind));
      registerEntityKinds(
        (data.entityKinds ?? []).filter(
          (def) => !knownKinds.has(def.kind) && !incompatible.has(kindOwner(def.kind) ?? ''),
        ),
      );
      set({ extensions: data.extensions.filter((e) => !incompatible.has(e.id)), loaded: true });
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
