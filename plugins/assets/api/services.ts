import { getDb, getExtensionServices, type DatabaseProvider, type Db } from '@greenhouse/api/extension-kit';
import { createAssetStore, type AssetStore } from './store.js';

export function createServices(db: Db) {
  return { store: createAssetStore(db) };
}
export type AssetServices = ReturnType<typeof createServices>;

export function assetStore(db: DatabaseProvider = getDb()): AssetStore {
  return getExtensionServices<AssetServices>(db, 'assets').store;
}
