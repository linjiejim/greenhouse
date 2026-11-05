/** Library-wide data the views share: configuration (facets, rights, limits), people and collections. */
import { create } from 'zustand';
import { api } from './api';
import type { Collection, Facet, LibraryConfig } from './types';
import type { Locale } from './embed';

interface LibraryState {
  config: LibraryConfig | null;
  people: Map<string, string>;
  collections: Collection[];
  /** Collections have answered once (an empty list before that is not "no collections"). */
  collectionsState: 'loading' | 'ready' | 'failed';
  loadConfig(): Promise<void>;
  loadPeople(): Promise<void>;
  loadCollections(): Promise<void>;
}

export const useLibrary = create<LibraryState>((set) => ({
  config: null,
  people: new Map(),
  collections: [],
  collectionsState: 'loading',
  async loadConfig() {
    set({ config: await api.config() });
  },
  async loadPeople() {
    set({ people: new Map((await api.people()).map((p) => [p.id, p.name])) });
  },
  async loadCollections() {
    try {
      set({ collections: (await api.collections()).collections, collectionsState: 'ready' });
    } catch (error) {
      set((s) => ({ collectionsState: s.collectionsState === 'ready' ? 'ready' : 'failed' }));
      throw error;
    }
  },
}));

export function facetLabel(facet: Facet, locale: Locale): string {
  return locale === 'zh' ? facet.label_zh || facet.label_en : facet.label_en || facet.label_zh;
}

export function valueLabel(facet: Facet, value: string, locale: Locale): string {
  const found = facet.values.find((v) => v.value === value);
  return locale === 'zh' && found?.zh ? found.zh : value;
}

/** The address of an asset inside the Greenhouse client (opens this page at that asset). */
export function assetLink(id: string): string {
  const route = `#/ext/assets/asset/${encodeURIComponent(id)}`;
  return `${window.location.origin}/p/assets/assets?route=${encodeURIComponent(route)}`;
}
